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
  const r1 = await api(
    'POST',
    '/api/register',
    {
      type: 'human',
      username: `task-creator-${ts}`,
      displayName: 'Task Creator',
    },
    '',
  );
  assert(r1.ok, `Register creator failed: ${JSON.stringify(r1)}`);
  creatorToken = r1.data.token;
  creatorId = r1.data.imUserId;

  // Agent (will be assigned tasks)
  const r2 = await api(
    'POST',
    '/api/register',
    {
      type: 'agent',
      username: `task-agent-${ts}`,
      displayName: 'Task Agent',
      agentType: 'assistant',
    },
    creatorToken,
  );
  assert(r2.ok, `Register agent failed: ${JSON.stringify(r2)}`);
  agentToken = r2.data.token;
  agentId = r2.data.imUserId;

  // Intruder (should be blocked from accessing others' tasks)
  const r3 = await api(
    'POST',
    '/api/register',
    {
      type: 'agent',
      username: `task-intruder-${ts}`,
      displayName: 'Intruder',
      agentType: 'assistant',
    },
    creatorToken,
  );
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

  await test('GET /tasks?view=board — excludes legacy chat agent_run rows', async () => {
    const runTask = await api('POST', '/api/tasks', {
      title: 'Legacy chat run should not be a board card',
      capability: 'chat',
      assigneeId: agentId,
      conversationId: 'conv-test-legacy',
      metadata: { kind: 'agent_run', triggerKind: 'mention', triggerMessageId: 'msg-test-legacy' },
    });
    assert(runTask.status === 201, `Expected legacy run task create 201, got ${runTask.status}`);

    const board = await api('GET', '/api/tasks?view=board&kind=work_item,goal&limit=100');
    assert(board.ok, 'Failed to list board tasks');
    const boardIds = board.data.map((t: any) => t.id);
    assert(!boardIds.includes(runTask.data.id), 'Board view must not include agent_run rows');

    const all = await api('GET', '/api/tasks?view=all&limit=100');
    assert(all.ok, 'Failed to list all tasks');
    const allIds = all.data.map((t: any) => t.id);
    assert(allIds.includes(runTask.data.id), 'view=all must include legacy agent_run rows');
  });

  await test('POST /tasks/:id/runs and GET /runs — execution attempts are separate from board', async () => {
    const created = await api('POST', `/api/tasks/${taskId}/runs`, {
      status: 'running',
      metadata: { reason: 'test-run-contract' },
    });
    assert(created.status === 201, `Expected run create 201, got ${created.status}`);
    assert(created.data.taskId === taskId, 'Run should link to parent task');

    const runs = await api('GET', `/api/runs?taskId=${taskId}&limit=20`);
    assert(runs.ok, 'Failed to list runs');
    const runIds = runs.data.map((r: any) => r.id);
    assert(runIds.includes(created.data.id), 'GET /runs should include created run');

    const filteredRuns = await api('GET', `/api/tasks?view=runs&taskId=${taskId}&limit=20`);
    assert(filteredRuns.ok, 'Failed to list runs via /tasks?view=runs');
    const filteredRunIds = filteredRuns.data.map((r: any) => r.id);
    assert(filteredRunIds.includes(created.data.id), 'view=runs should include created run');

    const board = await api('GET', '/api/tasks?view=board&kind=work_item,goal&limit=100');
    const boardIds = board.data.map((t: any) => t.id);
    assert(!boardIds.includes(created.data.id), 'Run id must not appear as a board task');
  });

  await test('PATCH /runs/:id completed — output exposed via GET /runs/:id/result (Wave-9 Phase 1)', async () => {
    // Wave-9 Phase 1: replaces the legacy "task-result IMAsset mirror"
    // assertion. The agent's run output is now canonically held in
    // IMTaskRun.output JSON and exposed via GET /api/im/runs/:id/result
    // with the locked shape:
    //   { taskId, status, output, metrics?, assetIds: string[],
    //     resultUri?: string|null, completedAt: string }
    const created = await api('POST', `/api/tasks/${taskId}/runs`, {
      status: 'running',
      metadata: { title: 'Markdown run result contract', reason: 'run-result-contract' },
    });
    assert(created.status === 201, `Expected run create 201, got ${created.status}`);
    const runId = created.data.id;
    const sentinel = `RUN-RESULT-${Date.now()}`;
    const markdown = `# Run Result\n\n- completed\n\n\`\`\`\n${sentinel}\n\`\`\``;

    const completed = await api('PATCH', `/api/runs/${runId}`, {
      status: 'completed',
      output: { output: markdown },
    });
    assert(completed.ok, `Run complete failed: ${JSON.stringify(completed)}`);
    assert(completed.data.status === 'completed', `Expected completed, got ${completed.data.status}`);

    const result = await api('GET', `/api/runs/${runId}/result`);
    assert(result.ok, `GET /runs/:id/result failed: ${JSON.stringify(result)}`);
    assert(result.data.taskId === runId, `Expected taskId=${runId}, got ${result.data.taskId}`);
    assert(result.data.status === 'completed', `Expected status=completed, got ${result.data.status}`);
    assert(typeof result.data.output === 'string', `Expected output string, got ${typeof result.data.output}`);
    assert(result.data.output.includes('# Run Result'), 'Result output should contain markdown heading');
    assert(result.data.output.includes('```'), 'Result output should contain fenced code block');
    assert(result.data.output.includes(sentinel), 'Result output should contain sentinel');
    assert(Array.isArray(result.data.assetIds), 'assetIds must be an array (possibly empty)');
    assert(typeof result.data.completedAt === 'string', 'completedAt must be ISO string');

    // Negative assertion (Phase 1 cleanup): the legacy task-result asset
    // mirror MUST NOT be created anymore. Library should stay clean.
    const listed = await api(
      'GET',
      `/api/assets?workspaceId=${created.data.workspaceId}&taskId=${runId}&kind=task-result&limit=10`,
    );
    assert(listed.ok, `Asset list failed: ${JSON.stringify(listed)}`);
    const orphans = (listed.data ?? []).filter(
      (asset: any) => asset.kind === 'task-result' && asset.sourceTaskId === runId,
    );
    assert(orphans.length === 0, `Wave-9 should not create task-result assets, got ${orphans.length}`);
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
    const res = await api(
      'PATCH',
      `/api/tasks/${ownerTaskId}`,
      {
        status: 'cancelled',
      },
      intruderToken,
    );
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('PATCH /tasks/:id — assignee cannot update (not creator)', async () => {
    const res = await api(
      'PATCH',
      `/api/tasks/${ownerTaskId}`,
      {
        metadata: { note: 'hacked' },
      },
      agentToken,
    );
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('PATCH /tasks/:id — creator CAN update', async () => {
    const res = await api('PATCH', `/api/tasks/${ownerTaskId}`, {
      metadata: { priority: 'high' },
    });
    assert(res.ok, 'Creator should be able to update');
  });

  await test('POST /tasks/:id/progress — intruder cannot report progress', async () => {
    const res = await api(
      'POST',
      `/api/tasks/${ownerTaskId}/progress`,
      {
        message: 'hacking',
      },
      intruderToken,
    );
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/progress — creator cannot report progress (not assignee)', async () => {
    const res = await api('POST', `/api/tasks/${ownerTaskId}/progress`, {
      message: 'not my job',
    });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/progress — assignee CAN report progress', async () => {
    const res = await api(
      'POST',
      `/api/tasks/${ownerTaskId}/progress`,
      {
        message: 'Working on it',
      },
      agentToken,
    );
    assert(res.ok, 'Assignee should be able to report progress');
  });

  await test('POST /tasks/:id/complete — intruder cannot complete', async () => {
    const res = await api(
      'POST',
      `/api/tasks/${ownerTaskId}/complete`,
      {
        result: 'hacked',
      },
      intruderToken,
    );
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/complete — creator cannot complete (not assignee)', async () => {
    const res = await api('POST', `/api/tasks/${ownerTaskId}/complete`, {
      result: 'not mine',
    });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/complete — assignee CAN complete', async () => {
    const res = await api(
      'POST',
      `/api/tasks/${ownerTaskId}/complete`,
      {
        result: { summary: 'Done' },
      },
      agentToken,
    );
    assert(res.ok, 'Assignee should be able to complete');
  });

  // Create another task for fail test
  const failRes = await api('POST', '/api/tasks', {
    title: 'Fail Ownership Test',
    assigneeId: agentId,
  });
  const failTaskId = failRes.data.id;

  await test('POST /tasks/:id/fail — intruder cannot fail', async () => {
    const res = await api(
      'POST',
      `/api/tasks/${failTaskId}/fail`,
      {
        error: 'hacked',
      },
      intruderToken,
    );
    assert(res.status === 403, `Expected 403, got ${res.status}`);
  });

  await test('POST /tasks/:id/fail — assignee CAN fail', async () => {
    const res = await api(
      'POST',
      `/api/tasks/${failTaskId}/fail`,
      {
        error: 'Legitimate failure',
      },
      agentToken,
    );
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
    const res = await api(
      'POST',
      `/api/tasks/${claimTaskId}/progress`,
      {
        message: 'Starting work',
      },
      agentToken,
    );
    assert(res.ok, 'Progress failed');

    const detail = await api('GET', `/api/tasks/${claimTaskId}`, undefined, agentToken);
    assert(detail.data.task.status === 'running', `Expected running, got ${detail.data.task.status}`);
  });

  await test('POST /tasks/:id/complete — marks completed', async () => {
    const res = await api(
      'POST',
      `/api/tasks/${claimTaskId}/complete`,
      {
        result: { output: 'done' },
      },
      agentToken,
    );
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
    const res = await api(
      'POST',
      `/api/tasks/${retryId}/fail`,
      {
        error: 'Temporary error',
      },
      agentToken,
    );
    assert(res.ok, 'Fail failed');
    assert(res.data.status === 'assigned', `Expected assigned (retry), got ${res.data.status}`);
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
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
