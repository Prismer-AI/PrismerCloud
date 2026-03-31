/**
 * Prismer IM — Task Orchestration Tests (with ownership/access control)
 *
 * Tests:
 *   - Task CRUD (create, list, get, update)
 *   - Task lifecycle (claim, progress, complete, fail, retry)
 *   - Ownership & access control (creator-only update, assignee-only lifecycle, cross-user rejection)
 *   - Scheduler (once, interval, dispatch)
 *   - Validation (missing fields, invalid states)
 *
 * Run: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/task-orchestration.test.ts
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';

let creatorToken = '';
let creatorId = '';
let agentToken = '';
let agentId = '';
let intruderToken = '';
let intruderId = '';

let passed = 0;
let failed = 0;
const results: { name: string; ok: boolean; error?: string }[] = [];

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    results.push({ name, ok: false, error: err.message });
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

async function api(method: string, path: string, body?: any, authToken?: string) {
  const tk = authToken ?? creatorToken;
  // In embedded mode (/api/im proxy), strip /api prefix to avoid /api/im/api/...
  const url = BASE.includes('/api/im') ? `${BASE}${path.replace(/^\/api/, '')}` : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, ...json };
}

// ─── Setup ─────────────────────────────────────────────────

async function setup() {
  console.log('\n🔧 Setup: Register 3 test users (creator, agent, intruder)');

  const ts = Date.now();

  // Creator (human)
  const r1 = await api('POST', '/api/register', {
    type: 'human',
    username: `task-creator-${ts}`,
    displayName: 'Task Creator',
  }, '');
  assert(r1.ok, `Register creator failed: ${JSON.stringify(r1)}`);
  creatorToken = r1.data.token;
  creatorId = r1.data.imUserId;

  // Agent (will be assigned tasks)
  const r2 = await api('POST', '/api/register', {
    type: 'agent',
    username: `task-agent-${ts}`,
    displayName: 'Task Agent',
    agentType: 'assistant',
  }, '');
  assert(r2.ok, `Register agent failed: ${JSON.stringify(r2)}`);
  agentToken = r2.data.token;
  agentId = r2.data.imUserId;

  // Intruder (should be blocked from accessing others' tasks)
  const r3 = await api('POST', '/api/register', {
    type: 'agent',
    username: `task-intruder-${ts}`,
    displayName: 'Intruder',
    agentType: 'assistant',
  }, '');
  assert(r3.ok, `Register intruder failed: ${JSON.stringify(r3)}`);
  intruderToken = r3.data.token;
  intruderId = r3.data.imUserId;

  console.log(`  Creator: ${creatorId}`);
  console.log(`  Agent:   ${agentId}`);
  console.log(`  Intruder: ${intruderId}`);
}

// ─── CRUD Tests ────────────────────────────────────────────

let taskId = '';

async function testCRUD() {
  console.log('\n📋 Task CRUD');

  await test('POST /tasks — create task', async () => {
    const res = await api('POST', '/api/tasks', {
      title: 'Test Task',
      description: 'A test task',
      capability: 'summarize',
      assigneeId: agentId,
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.data.id, 'Missing task id');
    assert(res.data.status === 'assigned', `Expected assigned, got ${res.data.status}`);
    assert(res.data.creatorId === creatorId, 'Wrong creatorId');
    assert(res.data.assigneeId === agentId, 'Wrong assigneeId');
    taskId = res.data.id;
  });

  await test('GET /tasks/:id — creator can view', async () => {
    const res = await api('GET', `/api/tasks/${taskId}`);
    assert(res.ok, 'Failed to get task');
    assert(res.data.task.id === taskId, 'Wrong task');
  });

  await test('GET /tasks/:id — assignee can view', async () => {
    const res = await api('GET', `/api/tasks/${taskId}`, undefined, agentToken);
    assert(res.ok, 'Assignee should be able to view assigned task');
  });

  await test('GET /tasks — default lists own tasks', async () => {
    const res = await api('GET', '/api/tasks');
    assert(res.ok, 'Failed to list tasks');
    assert(res.data.length >= 1, 'Should have at least 1 task');
    const ids = res.data.map((t: any) => t.id);
    assert(ids.includes(taskId), 'Should include created task');
  });

  await test('GET /tasks — agent sees assigned tasks', async () => {
    const res = await api('GET', '/api/tasks', undefined, agentToken);
    assert(res.ok, 'Failed to list tasks');
    const ids = res.data.map((t: any) => t.id);
    assert(ids.includes(taskId), 'Agent should see assigned task');
  });

  await test('POST /tasks — create with missing title → 400', async () => {
    const res = await api('POST', '/api/tasks', { description: 'no title' });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /tasks — invalid scheduleType → 400', async () => {
    const res = await api('POST', '/api/tasks', { title: 'T', scheduleType: 'invalid' });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /tasks — cron without expression → 400', async () => {
    const res = await api('POST', '/api/tasks', { title: 'T', scheduleType: 'cron' });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('GET /tasks/nonexistent → 404', async () => {
    const res = await api('GET', '/api/tasks/nonexistent-id-123');
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });
}

// ─── Ownership & Access Control Tests ──────────────────────

async function testOwnership() {
  console.log('\n🔒 Ownership & Access Control');

  // Create a task specifically for ownership tests
  const createRes = await api('POST', '/api/tasks', {
    title: 'Ownership Test Task',
    capability: 'test',
    assigneeId: agentId,
  });
  const ownerTaskId = createRes.data.id;

  await test('GET /tasks/:id — intruder cannot view assigned task', async () => {
    const res = await api('GET', `/api/tasks/${ownerTaskId}`, undefined, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('PATCH /tasks/:id — intruder cannot update', async () => {
    const res = await api('PATCH', `/api/tasks/${ownerTaskId}`, {
      status: 'cancelled',
    }, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('PATCH /tasks/:id — assignee cannot update (not creator)', async () => {
    const res = await api('PATCH', `/api/tasks/${ownerTaskId}`, {
      metadata: { note: 'hacked' },
    }, agentToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('PATCH /tasks/:id — creator CAN update', async () => {
    const res = await api('PATCH', `/api/tasks/${ownerTaskId}`, {
      metadata: { priority: 'high' },
    });
    assert(res.ok, 'Creator should be able to update');
  });

  await test('POST /tasks/:id/progress — intruder cannot report progress', async () => {
    const res = await api('POST', `/api/tasks/${ownerTaskId}/progress`, {
      message: 'hacking',
    }, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/progress — creator cannot report progress (not assignee)', async () => {
    const res = await api('POST', `/api/tasks/${ownerTaskId}/progress`, {
      message: 'not my job',
    });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/progress — assignee CAN report progress', async () => {
    const res = await api('POST', `/api/tasks/${ownerTaskId}/progress`, {
      message: 'Working on it',
    }, agentToken);
    assert(res.ok, 'Assignee should be able to report progress');
  });

  await test('POST /tasks/:id/complete — intruder cannot complete', async () => {
    const res = await api('POST', `/api/tasks/${ownerTaskId}/complete`, {
      result: 'hacked',
    }, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/complete — creator cannot complete (not assignee)', async () => {
    const res = await api('POST', `/api/tasks/${ownerTaskId}/complete`, {
      result: 'not mine',
    });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/complete — assignee CAN complete', async () => {
    const res = await api('POST', `/api/tasks/${ownerTaskId}/complete`, {
      result: { summary: 'Done' },
    }, agentToken);
    assert(res.ok, 'Assignee should be able to complete');
  });

  // Create another task for fail test
  const failRes = await api('POST', '/api/tasks', {
    title: 'Fail Ownership Test',
    assigneeId: agentId,
  });
  const failTaskId = failRes.data.id;

  await test('POST /tasks/:id/fail — intruder cannot fail', async () => {
    const res = await api('POST', `/api/tasks/${failTaskId}/fail`, {
      error: 'hacked',
    }, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/fail — assignee CAN fail', async () => {
    const res = await api('POST', `/api/tasks/${failTaskId}/fail`, {
      error: 'Legitimate failure',
    }, agentToken);
    assert(res.ok, 'Assignee should be able to fail');
  });

  // Test list filtering restrictions
  await test('GET /tasks?creatorId=other — rejected', async () => {
    const res = await api('GET', `/api/tasks?creatorId=${creatorId}`, undefined, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('GET /tasks?assigneeId=other — rejected', async () => {
    const res = await api('GET', `/api/tasks?assigneeId=${agentId}`, undefined, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  // Marketplace visibility: pending unassigned tasks should be visible
  const mpRes = await api('POST', '/api/tasks', {
    title: 'Marketplace Task',
    capability: 'analyze',
  });
  const mpTaskId = mpRes.data.id;

  await test('GET /tasks/:id — pending unassigned task visible to anyone (marketplace)', async () => {
    const res = await api('GET', `/api/tasks/${mpTaskId}`, undefined, intruderToken);
    assert(res.ok, 'Pending unassigned task should be visible to all (marketplace)');
  });

  // Claim it and verify intruder can no longer see it
  await api('POST', `/api/tasks/${mpTaskId}/claim`, undefined, agentToken);

  await test('GET /tasks/:id — after claim, intruder cannot view', async () => {
    const res = await api('GET', `/api/tasks/${mpTaskId}`, undefined, intruderToken);
    assert(res.status === 403, `Expected 403 after claim, got ${res.status}`);
  });
}

// ─── Lifecycle Tests ───────────────────────────────────────

async function testLifecycle() {
  console.log('\n🔄 Task Lifecycle');

  // Create task for claim test
  const unassigned = await api('POST', '/api/tasks', { title: 'Claimable Task', capability: 'test' });
  const claimTaskId = unassigned.data.id;

  await test('POST /tasks/:id/claim — agent claims pending task', async () => {
    const res = await api('POST', `/api/tasks/${claimTaskId}/claim`, undefined, agentToken);
    assert(res.ok, 'Claim failed');
    assert(res.data.status === 'assigned', `Expected assigned, got ${res.data.status}`);
    assert(res.data.assigneeId === agentId, 'Wrong assignee');
  });

  await test('POST /tasks/:id/claim — double claim rejected', async () => {
    const res = await api('POST', `/api/tasks/${claimTaskId}/claim`, undefined, intruderToken);
    assert(res.status === 409, `Expected 409, got ${res.status}`);
  });

  await test('POST /tasks/:id/progress — transitions assigned → running', async () => {
    const res = await api('POST', `/api/tasks/${claimTaskId}/progress`, {
      message: 'Starting work',
    }, agentToken);
    assert(res.ok, 'Progress failed');

    const detail = await api('GET', `/api/tasks/${claimTaskId}`, undefined, agentToken);
    assert(detail.data.task.status === 'running', `Expected running, got ${detail.data.task.status}`);
  });

  await test('POST /tasks/:id/complete — marks completed', async () => {
    const res = await api('POST', `/api/tasks/${claimTaskId}/complete`, {
      result: { output: 'done' },
    }, agentToken);
    assert(res.ok, 'Complete failed');
    assert(res.data.status === 'completed', `Expected completed, got ${res.data.status}`);
  });

  // Retry test
  const retryTask = await api('POST', '/api/tasks', {
    title: 'Retry Task',
    assigneeId: agentId,
    maxRetries: 2,
    retryDelayMs: 100,
  });
  const retryId = retryTask.data.id;

  await test('POST /tasks/:id/fail — retry on first failure', async () => {
    const res = await api('POST', `/api/tasks/${retryId}/fail`, {
      error: 'Temporary error',
    }, agentToken);
    assert(res.ok, 'Fail failed');
    assert(res.data.status === 'pending', `Expected pending (retry), got ${res.data.status}`);
    assert(res.data.retryCount === 1, `Expected retryCount 1, got ${res.data.retryCount}`);
  });

  // Cancel test
  const cancelTask = await api('POST', '/api/tasks', {
    title: 'Cancel Test',
    assigneeId: agentId,
  });

  await test('PATCH /tasks/:id — creator cancels task', async () => {
    const res = await api('PATCH', `/api/tasks/${cancelTask.data.id}`, { status: 'cancelled' });
    assert(res.ok, 'Cancel failed');
    assert(res.data.status === 'cancelled', `Expected cancelled, got ${res.data.status}`);
  });

  // Self-assign test
  await test('POST /tasks — assigneeId: "self" resolves to creator', async () => {
    const res = await api('POST', '/api/tasks', {
      title: 'Self-Assign',
      assigneeId: 'self',
    });
    assert(res.ok, 'Create failed');
    assert(res.data.assigneeId === creatorId, `Expected self-assign to ${creatorId}`);
  });

  // Logs trail test
  await test('GET /tasks/:id — logs trail present', async () => {
    const res = await api('GET', `/api/tasks/${claimTaskId}`);
    assert(res.ok, 'Get failed');
    assert(res.data.logs.length >= 3, `Expected ≥3 logs, got ${res.data.logs.length}`);
    const actions = res.data.logs.map((l: any) => l.action);
    assert(actions.includes('created'), 'Missing created log');
    assert(actions.includes('claimed'), 'Missing claimed log');
    assert(actions.includes('completed'), 'Missing completed log');
  });
}

// ─── Scheduler Tests ───────────────────────────────────────

async function testScheduler() {
  console.log('\n⏰ Scheduler');

  await test('POST /tasks — once-task with future scheduleAt', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const res = await api('POST', '/api/tasks', {
      title: 'Scheduled Once',
      scheduleType: 'once',
      scheduleAt: future,
      assigneeId: 'self',
    });
    assert(res.ok, 'Create failed');
    assert(res.data.status === 'pending', 'Scheduled tasks start as pending');
    assert(res.data.scheduleType === 'once', 'Wrong scheduleType');
  });

  await test('POST /tasks — interval task', async () => {
    const res = await api('POST', '/api/tasks', {
      title: 'Interval Task',
      scheduleType: 'interval',
      intervalMs: 60000,
      assigneeId: 'self',
    });
    assert(res.ok, 'Create failed');
    assert(res.data.scheduleType === 'interval', 'Wrong scheduleType');
  });

  await test('POST /tasks — cron task', async () => {
    const res = await api('POST', '/api/tasks', {
      title: 'Cron Task',
      scheduleType: 'cron',
      scheduleCron: '0 9 * * *',
      assigneeId: 'self',
    });
    assert(res.ok, 'Create failed');
    assert(res.data.scheduleType === 'cron', 'Wrong scheduleType');
  });

  await test('POST /tasks — interval without intervalMs → 400', async () => {
    const res = await api('POST', '/api/tasks', {
      title: 'T',
      scheduleType: 'interval',
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /tasks — once without scheduleAt → 400', async () => {
    const res = await api('POST', '/api/tasks', {
      title: 'T',
      scheduleType: 'once',
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });
}

// ─── Evolution Ownership Tests ─────────────────────────────

async function testEvolutionOwnership() {
  console.log('\n🧬 Evolution Ownership');

  await test('GET /evolution/personality/:id — own agent OK', async () => {
    const res = await api('GET', `/api/evolution/personality/${agentId}`, undefined, agentToken);
    assert(res.ok, `Expected ok, got error: ${res.error}`);
  });

  await test('GET /evolution/personality/:id — other agent → 403', async () => {
    const res = await api('GET', `/api/evolution/personality/${agentId}`, undefined, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('GET /evolution/report — defaults to self', async () => {
    const res = await api('GET', '/api/evolution/report', undefined, agentToken);
    assert(res.ok, `Expected ok, got error: ${res.error}`);
  });

  await test('GET /evolution/report?agent_id=other → 403', async () => {
    const res = await api('GET', `/api/evolution/report?agent_id=${agentId}`, undefined, intruderToken);
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' Prismer IM — Task Orchestration + Ownership Tests');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Target: ${BASE}`);

  await setup();
  await testCRUD();
  await testOwnership();
  await testLifecycle();
  await testScheduler();
  await testEvolutionOwnership();

  console.log('\n═══════════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('═══════════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
