/**
 * Task-backed Goals API smoke test.
 *
 * Run:
 *   TEST_BASE_URL=http://localhost:3210 DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/goals-api.test.ts
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';

let token = '';
let workspaceId = '';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function api(method: string, path: string, body?: unknown, auth = token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { ok: false, error: text };
  }
  return { status: res.status, ...(json ?? {}) };
}

async function main() {
  const ts = Date.now();
  const reg = await api(
    'POST',
    '/api/register',
    { type: 'human', username: `goal-owner-${ts}`, displayName: 'Goal Owner' },
    '',
  );
  assert(reg.ok, `register failed: ${JSON.stringify(reg)}`);
  token = reg.data.token;

  const workspaces = await api('GET', '/api/workspaces');
  assert(workspaces.ok, `workspace list failed: ${JSON.stringify(workspaces)}`);
  workspaceId = workspaces.data?.[0]?.id;
  assert(workspaceId, 'missing default workspace');

  const created = await api('POST', '/api/goals', {
    workspaceId,
    title: 'Keep release quality high',
    description: 'Continuously find release blockers',
    priority: 'high',
  });
  assert(created.status === 201, `goal create expected 201, got ${created.status}: ${JSON.stringify(created)}`);
  assert(created.data.metadata.kind === 'goal', 'created goal kind');
  assert(created.data.metadata.goal.status === 'active', 'created goal active');
  const goalId = created.data.id;

  const listed = await api('GET', `/api/goals?workspaceId=${encodeURIComponent(workspaceId)}`);
  assert(listed.ok, 'goal list failed');
  assert(
    listed.data.some((goal: any) => goal.id === goalId),
    'goal list includes created goal',
  );

  const paused = await api('PATCH', `/api/goals/${goalId}/pause`);
  assert(paused.ok, 'pause failed');
  assert(paused.data.metadata.goal.status === 'paused', 'goal paused');

  const resumed = await api('PATCH', `/api/goals/${goalId}/resume`);
  assert(resumed.ok, 'resume failed');
  assert(resumed.data.metadata.goal.status === 'active', 'goal resumed');

  const completed = await api('PATCH', `/api/goals/${goalId}/complete`);
  assert(completed.ok, 'complete failed');
  assert(completed.data.metadata.goal.status === 'completed', 'goal completed metadata');
  assert(completed.data.status === 'completed', 'goal completed task status');

  const task = await api('POST', '/api/tasks', { workspaceId, title: 'Not a goal' });
  const rejected = await api('PATCH', `/api/goals/${task.data.id}/pause`);
  assert(rejected.status === 400, `non-goal pause should reject, got ${rejected.status}`);

  console.log('goals-api: PASS');
}

main().catch((err) => {
  console.error('goals-api: FAIL', err);
  process.exitCode = 1;
});
