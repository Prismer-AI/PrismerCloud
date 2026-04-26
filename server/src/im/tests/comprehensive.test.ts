/**
 * Prismer IM — Comprehensive Integration Tests
 *
 * Covers: Workspace, Agents, Messages CRUD, Direct, Groups, Conversations,
 *         Edge Cases, Authorization, Error Handling
 *
 * Usage: npx tsx src/im/tests/comprehensive.test.ts
 */

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';
const TS = String(Date.now()).slice(-8);

// ─── Test Infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];
const suiteResults: { name: string; passed: number; failed: number }[] = [];
let suiteP = 0;
let suiteF = 0;

function suite(name: string) {
  if (suiteP || suiteF) {
    suiteResults.push({ name: currentSuite, passed: suiteP, failed: suiteF });
  }
  suiteP = 0;
  suiteF = 0;
  currentSuite = name;
  console.log(`\n🔹 ${name}`);
}
let currentSuite = '';

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    suiteP++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    suiteF++;
    const msg = err.message || String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function api(method: string, path: string, body?: any, token?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
}

// ─── Test State ─────────────────────────────────────────────
let userAToken = '';
let userAId = '';
let userBToken = '';
let userBId = '';
let agentXToken = '';
let agentXId = '';
let agentYToken = '';
let agentYId = '';

// Shared IDs
let workspaceConvId = '';
let directConvId = '';
let groupConvId = '';
let testMessageId = '';

// ─── Helper: Register via /users/register ───────────────────
async function createTestUser(
  username: string,
  displayName: string,
  role: string = 'human',
  agentType?: string,
): Promise<{ id: string; token: string }> {
  const res = await api('POST', '/users/register', {
    username,
    displayName,
    role,
    agentType,
    password: 'test123',
  });
  if (!res.data.ok) throw new Error(`createTestUser failed: ${JSON.stringify(res.data)}`);
  return { id: res.data.data.user.id, token: res.data.data.token };
}

// ═══════════════════════════════════════════════════════════════
// Main test runner
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   Prismer IM — Comprehensive Integration Tests   ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`\nServer: ${BASE}`);

  // Health check
  const health = await api('GET', '/health');
  if (!health.data.ok) {
    console.error('Server not ready!');
    process.exit(1);
  }
  console.log(`Health: ✅ (v${health.data.version})`);

  // ─── Setup: Create test users ───────────────────────────
  console.log('\n⚙️  Setting up test users...');
  const uA = await createTestUser(`comp_ua_${TS}`, 'User Alpha');
  userAToken = uA.token;
  userAId = uA.id;

  const uB = await createTestUser(`comp_ub_${TS}`, 'User Beta');
  userBToken = uB.token;
  userBId = uB.id;

  const aX = await createTestUser(`comp_ax_${TS}`, 'Agent X', 'agent', 'assistant');
  agentXToken = aX.token;
  agentXId = aX.id;

  const aY = await createTestUser(`comp_ay_${TS}`, 'Agent Y', 'agent', 'specialist');
  agentYToken = aY.token;
  agentYId = aY.id;

  console.log(
    `  Users: A=${userAId.slice(0, 8)}… B=${userBId.slice(0, 8)}… X=${agentXId.slice(0, 8)}… Y=${agentYId.slice(0, 8)}…`,
  );

  // ═══════════════════════════════════════════════════════════
  // 1. WORKSPACE API
  // ═══════════════════════════════════════════════════════════
  suite('Workspace Init');

  await test('W1: Init workspace with user + agent', async () => {
    const res = await api(
      'POST',
      '/workspace/init',
      {
        workspaceId: `ws_${TS}_1`,
        userId: `cloud_user_${TS}`,
        userDisplayName: 'Workspace User',
        agentName: `ws_agent_${TS}`,
        agentDisplayName: 'WS Agent',
        agentType: 'assistant',
        agentCapabilities: ['code', 'review'],
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.conversationId, 'has conversationId');
    assert(res.data.data.user.imUserId, 'has user.imUserId');
    assert(res.data.data.user.token, 'has user token');
    assert(res.data.data.agent.token, 'has agent token');
    assert(res.data.data.agent.conversationId, 'has agent conversationId');
    workspaceConvId = res.data.data.conversationId;
  });

  await test('W2: Init workspace without agent', async () => {
    const res = await api(
      'POST',
      '/workspace/init',
      {
        workspaceId: `ws_${TS}_2`,
        userId: `cloud_user2_${TS}`,
        userDisplayName: 'Solo User',
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    assertEqual(res.data.data.agent, null, 'no agent');
  });

  await test('W3: Init workspace missing required fields', async () => {
    const res = await api(
      'POST',
      '/workspace/init',
      {
        workspaceId: `ws_${TS}_3`,
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
    assert(!res.data.ok, 'not ok');
  });

  await test('W4: Init workspace without auth', async () => {
    const res = await api('POST', '/workspace/init', {
      workspaceId: `ws_${TS}_4`,
      userId: 'u1',
      userDisplayName: 'U1',
    });
    assertEqual(res.status, 401, 'status');
  });

  suite('Workspace Init-Group');

  await test('W5: Init group workspace with users + agents', async () => {
    const res = await api(
      'POST',
      '/workspace/init-group',
      {
        workspaceId: `wsg_${TS}_1`,
        title: 'Team Chat',
        description: 'Team workspace',
        users: [
          { userId: `guser1_${TS}`, displayName: 'G-User 1' },
          { userId: `guser2_${TS}`, displayName: 'G-User 2' },
        ],
        agents: [
          { name: `gagent1_${TS}`, displayName: 'G-Agent 1', type: 'assistant', capabilities: ['code'] },
          { name: `gagent2_${TS}`, displayName: 'G-Agent 2', type: 'specialist' },
        ],
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    assertEqual(res.data.data.conversationType, 'group', 'type');
    assertEqual(res.data.data.users.length, 2, 'user count');
    assertEqual(res.data.data.agents.length, 2, 'agent count');
    assert(res.data.data.users[0].token, 'user has token');
    assert(res.data.data.agents[0].token, 'agent has token');
  });

  await test('W6: Init group missing title', async () => {
    const res = await api(
      'POST',
      '/workspace/init-group',
      {
        workspaceId: `wsg_${TS}_2`,
        users: [{ userId: 'u1', displayName: 'U1' }],
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
  });

  await test('W7: Init group with empty users', async () => {
    const res = await api(
      'POST',
      '/workspace/init-group',
      {
        workspaceId: `wsg_${TS}_3`,
        title: 'Empty',
        users: [],
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
  });

  await test('W8: Init group users missing required fields', async () => {
    const res = await api(
      'POST',
      '/workspace/init-group',
      {
        workspaceId: `wsg_${TS}_4`,
        title: 'Bad',
        users: [{ displayName: 'No ID' }],
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
  });

  await test('W9: Duplicate workspace init fails', async () => {
    const res = await api(
      'POST',
      '/workspace/init-group',
      {
        workspaceId: `wsg_${TS}_1`, // same as W5
        title: 'Dup',
        users: [{ userId: `dup_${TS}`, displayName: 'Dup' }],
      },
      userAToken,
    );
    assertEqual(res.status, 500, 'status');
    assert(res.data.error.includes('already has a conversation'), 'error message');
  });

  suite('Workspace Operations');

  await test('W10: Get workspace conversation', async () => {
    const res = await api('GET', `/workspace/ws_${TS}_1/conversation`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.participants.length >= 2, 'has participants');
  });

  await test('W11: Get non-existent workspace conversation', async () => {
    const res = await api('GET', '/workspace/nonexistent/conversation', undefined, userAToken);
    assertEqual(res.status, 404, 'status');
  });

  await test('W12: Add agent to workspace', async () => {
    const res = await api(
      'POST',
      `/workspace/ws_${TS}_1/agents`,
      {
        agentName: `ws_agent2_${TS}`,
        agentDisplayName: 'WS Agent 2',
        agentType: 'specialist',
        capabilities: ['search'],
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.token, 'has token');
  });

  await test('W13: Add agent missing required fields', async () => {
    const res = await api(
      'POST',
      `/workspace/ws_${TS}_1/agents`,
      {
        agentName: 'only_name',
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
  });

  await test('W14: List workspace agents', async () => {
    const res = await api('GET', `/workspace/ws_${TS}_1/agents`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.length >= 2, 'has agents');
  });

  await test('W15: Get workspace messages (empty)', async () => {
    const res = await api('GET', `/workspace/ws_${TS}_2/messages`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(Array.isArray(res.data.data), 'is array');
  });

  await test('W16: Generate agent token', async () => {
    // First get agent from listing
    const list = await api('GET', `/workspace/ws_${TS}_1/agents`, undefined, userAToken);
    const agentUserId = list.data.data[0].userId;
    const res = await api('POST', `/workspace/ws_${TS}_1/agents/${agentUserId}/token`, {}, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.token, 'has token');
  });

  await test('W17: Mentions autocomplete', async () => {
    const res = await api(
      'GET',
      `/workspace/mentions/autocomplete?conversationId=${workspaceConvId}&query=&limit=10`,
      undefined,
      userAToken,
    );
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(Array.isArray(res.data.data), 'is array');
  });

  await test('W18: Mentions autocomplete missing conversationId', async () => {
    const res = await api('GET', '/workspace/mentions/autocomplete?query=test', undefined, userAToken);
    assertEqual(res.status, 400, 'status');
  });

  // ═══════════════════════════════════════════════════════════
  // 2. AGENTS API
  // ═══════════════════════════════════════════════════════════
  suite('Agents Registration');

  await test('A1: Register agent card', async () => {
    const res = await api(
      'POST',
      '/agents/register',
      {
        name: 'Agent X Card',
        description: 'Test agent with code capabilities',
        agentType: 'assistant',
        capabilities: ['code', 'review', 'test'],
        endpoint: 'http://localhost:9999/agent-x',
      },
      agentXToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.agentId, 'has agentId');
    assertEqual(res.data.data.userId, agentXId, 'userId');
  });

  await test('A2: Register second agent card', async () => {
    const res = await api(
      'POST',
      '/agents/register',
      {
        name: 'Agent Y Card',
        description: 'Specialist agent for search',
        agentType: 'specialist',
        capabilities: ['search', 'data'],
      },
      agentYToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('A3: Human cannot register agent card', async () => {
    const res = await api(
      'POST',
      '/agents/register',
      {
        name: 'Fake Agent',
        description: "Humans can't register",
      },
      userAToken,
    );
    assertEqual(res.status, 403, 'status');
  });

  await test('A4: Agent registration missing fields', async () => {
    const res = await api(
      'POST',
      '/agents/register',
      {
        name: 'Missing Desc',
      },
      agentXToken,
    );
    assertEqual(res.status, 400, 'status');
  });

  suite('Agents Discovery');

  await test('A5: Discover all agents', async () => {
    const res = await api('GET', '/agents', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.length >= 2, 'has agents');
  });

  await test('A6: Discover by agent type', async () => {
    const res = await api('GET', '/agents?agentType=specialist', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.length >= 1, 'has specialist agents');
  });

  await test('A7: Get agent details', async () => {
    const res = await api('GET', `/agents/${agentXId}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.card || res.data.data.name, 'has card info');
  });

  await test('A8: Get non-existent agent', async () => {
    const res = await api('GET', '/agents/nonexistent_user_id', undefined, userAToken);
    assertEqual(res.status, 404, 'status');
  });

  suite('Agents Heartbeat');

  await test('A9: Agent sends heartbeat', async () => {
    const res = await api(
      'POST',
      `/agents/${agentXId}/heartbeat`,
      {
        status: 'online',
        load: 0.3,
        activeConversations: 2,
      },
      agentXToken,
    );
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('A10: Cannot send heartbeat for another agent', async () => {
    const res = await api(
      'POST',
      `/agents/${agentXId}/heartbeat`,
      {
        status: 'online',
      },
      agentYToken,
    );
    assertEqual(res.status, 403, 'status');
  });

  suite('Agents Unregister');

  // Create a disposable agent for unregister test
  await test('A11: Agent unregisters self', async () => {
    const disposable = await createTestUser(`disp_${TS}`, 'Disposable Agent', 'agent', 'bot');
    // Register card
    await api(
      'POST',
      '/agents/register',
      {
        name: 'Disposable',
        description: 'Will be unregistered',
      },
      disposable.token,
    );
    // Unregister
    const res = await api('DELETE', `/agents/${disposable.id}`, undefined, disposable.token);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('A12: Cannot unregister another agent (non-admin)', async () => {
    const res = await api('DELETE', `/agents/${agentXId}`, undefined, agentYToken);
    assertEqual(res.status, 403, 'status');
  });

  // ═══════════════════════════════════════════════════════════
  // 3. MESSAGES CRUD
  // ═══════════════════════════════════════════════════════════
  suite('Messages - Setup');

  // Create a direct conversation for message tests
  await test('MSG0: Create conversation for message tests', async () => {
    const res = await api(
      'POST',
      '/conversations/direct',
      {
        otherUserId: userBId,
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    directConvId = res.data.data.id;
    assert(directConvId, 'has convId');
  });

  suite('Messages - Send');

  await test('MSG1: Send text message', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        content: 'Hello from User A!',
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.message.id, 'has message id');
    testMessageId = res.data.data.message.id;
  });

  await test('MSG2: Send markdown message', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        type: 'markdown',
        content: '# Hello\n\n**Bold** and *italic*',
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('MSG3: Send message with metadata', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        content: 'Message with meta',
        metadata: { priority: 'high', source: 'api' },
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('MSG4: Send message with parentId (threading)', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        content: 'Reply to first message',
        parentId: testMessageId,
      },
      userBToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('MSG5: Non-participant cannot send message', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        type: 'tool_call',
        content: '',
        metadata: { tool: 'search', args: { query: 'test' } },
      },
      agentXToken,
    );
    assertEqual(res.status, 403, 'status');
    assert(!res.data.ok, 'not ok');
  });

  await test('MSG6: Send empty content text message fails', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        type: 'text',
        content: '',
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
    assert(!res.data.ok, 'not ok');
  });

  await test('MSG7: Send system_event without content (allowed)', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        type: 'system_event',
        content: '',
        metadata: { event: 'user_joined' },
      },
      userAToken,
    );
    // system_event with empty content should be allowed
    assertEqual(res.status, 201, 'status');
  });

  await test('MSG8: Send message with @mention', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        content: `Hey @comp_ub_${TS} check this out!`,
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    // Check routing info
    if (res.data.data.routing) {
      assert(res.data.data.routing.mode, 'has routing mode');
    }
  });

  suite('Messages - History & Pagination');

  await test('MSG9: Get message history', async () => {
    const res = await api('GET', `/messages/${directConvId}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.length >= 4, 'has messages');
    assert(res.data.meta.total >= 4, 'has total');
  });

  await test('MSG10: Get history with limit', async () => {
    const res = await api('GET', `/messages/${directConvId}?limit=2`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assertEqual(res.data.data.length, 2, 'limited to 2');
  });

  await test('MSG11: Non-participant cannot get history', async () => {
    const res = await api('GET', `/messages/${directConvId}`, undefined, agentXToken);
    assertEqual(res.status, 403, 'status');
  });

  suite('Messages - Edit');

  await test('MSG12: Edit own message', async () => {
    const res = await api(
      'PATCH',
      `/messages/${directConvId}/${testMessageId}`,
      {
        content: 'Hello from User A! (edited)',
      },
      userAToken,
    );
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('MSG13: Edit message - verify content changed', async () => {
    const history = await api('GET', `/messages/${directConvId}?limit=50`, undefined, userAToken);
    const msg = history.data.data.find((m: any) => m.id === testMessageId);
    assert(msg, 'message found');
    assert(msg.content.includes('edited'), 'content updated');
  });

  await test("MSG14: Cannot edit other user's message", async () => {
    const res = await api(
      'PATCH',
      `/messages/${directConvId}/${testMessageId}`,
      {
        content: "Trying to edit A's message",
      },
      userBToken,
    );
    assertEqual(res.status, 403, 'status');
  });

  await test('MSG15: Edit non-existent message', async () => {
    const res = await api(
      'PATCH',
      `/messages/${directConvId}/nonexistent_id`,
      {
        content: 'Ghost edit',
      },
      userAToken,
    );
    assertEqual(res.status, 404, 'status');
  });

  suite('Messages - Delete');

  // Send a message to delete
  let deleteTargetId = '';
  await test('MSG16: Send message to be deleted', async () => {
    const res = await api(
      'POST',
      `/messages/${directConvId}`,
      {
        content: 'This will be deleted',
      },
      userAToken,
    );
    deleteTargetId = res.data.data.message.id;
    assert(deleteTargetId, 'got message id');
  });

  await test("MSG17: Cannot delete other user's message", async () => {
    const res = await api('DELETE', `/messages/${directConvId}/${deleteTargetId}`, undefined, userBToken);
    assertEqual(res.status, 403, 'status');
  });

  await test('MSG18: Delete own message', async () => {
    const res = await api('DELETE', `/messages/${directConvId}/${deleteTargetId}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('MSG19: Deleted message not in history', async () => {
    const history = await api('GET', `/messages/${directConvId}?limit=50`, undefined, userAToken);
    const found = history.data.data.find((m: any) => m.id === deleteTargetId);
    assert(!found, 'message should be deleted from history');
  });

  await test('MSG20: Delete non-existent message', async () => {
    const res = await api('DELETE', `/messages/${directConvId}/nonexistent_msg`, undefined, userAToken);
    assertEqual(res.status, 404, 'status');
  });

  // ═══════════════════════════════════════════════════════════
  // 4. DIRECT API (Simplified)
  // ═══════════════════════════════════════════════════════════
  suite('Direct API');

  await test('D1: Send direct message by username', async () => {
    const res = await api(
      'POST',
      `/direct/comp_ub_${TS}/messages`,
      {
        content: 'Direct hello via username!',
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.conversationId, 'has conversationId');
  });

  await test('D2: Send direct message by user ID', async () => {
    const res = await api(
      'POST',
      `/direct/${userBId}/messages`,
      {
        content: 'Direct hello via ID!',
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('D3: Cannot message yourself', async () => {
    const res = await api(
      'POST',
      `/direct/${userAId}/messages`,
      {
        content: 'Hello me!',
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
    assert(res.data.error.includes('yourself'), 'error mentions yourself');
  });

  await test('D4: Message non-existent user', async () => {
    const res = await api(
      'POST',
      '/direct/totally_nonexistent_user/messages',
      {
        content: 'Hello ghost!',
      },
      userAToken,
    );
    assertEqual(res.status, 404, 'status');
  });

  await test('D5: Get direct message history', async () => {
    const res = await api('GET', `/direct/comp_ub_${TS}/messages`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.length >= 1, 'has messages');
    assert(res.data.meta.total >= 1, 'has total');
  });

  await test('D6: Get direct history with no conversation yet', async () => {
    // agentY hasn't messaged anyone via direct API
    const res = await api('GET', `/direct/${agentYId}/messages`, undefined, agentXToken);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.length, 0, 'empty history');
  });

  await test('D7: Get direct conversation info', async () => {
    const res = await api('GET', `/direct/comp_ub_${TS}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assertEqual(res.data.data.exists, true, 'exists');
    assert(res.data.data.conversationId, 'has conversationId');
    assert(res.data.data.participants.length >= 2, 'has participants');
  });

  await test('D8: Get direct conversation info (no conversation)', async () => {
    const res = await api('GET', `/direct/${agentYId}`, undefined, agentXToken);
    assertEqual(res.status, 200, 'status');
    assertEqual(res.data.data.exists, false, 'not exists');
  });

  await test('D9: Send direct message empty content fails', async () => {
    const res = await api(
      'POST',
      `/direct/comp_ub_${TS}/messages`,
      {
        content: '',
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
  });

  // ═══════════════════════════════════════════════════════════
  // 5. GROUPS API (Simplified)
  // ═══════════════════════════════════════════════════════════
  suite('Groups API - Create');

  await test('G1: Create group', async () => {
    const res = await api(
      'POST',
      '/groups',
      {
        title: 'Test Group',
        description: 'A test group',
        members: [userBId, agentXId],
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
    groupConvId = res.data.data.groupId;
    assert(groupConvId, 'has groupId');
    // Creator + 2 members = 3
    assert(res.data.data.members.length >= 3, 'has members');
  });

  await test('G2: Create group title required', async () => {
    const res = await api(
      'POST',
      '/groups',
      {
        description: 'No title',
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
  });

  await test('G3: Create group with no additional members', async () => {
    const res = await api(
      'POST',
      '/groups',
      {
        title: 'Solo Group',
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    // Just the creator
    assertEqual(res.data.data.members.length, 1, 'just creator');
  });

  await test('G4: Create group with non-existent member (silently skipped)', async () => {
    const res = await api(
      'POST',
      '/groups',
      {
        title: 'Skip Bad Members',
        members: ['nonexistent_user_abc', userBId],
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    // nonexistent should be skipped, only creator + userB
    assertEqual(res.data.data.members.length, 2, 'skipped nonexistent');
  });

  await test('G5: Create group with duplicate members (creator in list)', async () => {
    const res = await api(
      'POST',
      '/groups',
      {
        title: 'Dedup Group',
        members: [userAId, userBId], // userA is creator, should be deduped
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    // Creator + userB (creator deduped from members list)
    assertEqual(res.data.data.members.length, 2, 'deduped creator');
  });

  suite('Groups API - Operations');

  await test('G6: List my groups', async () => {
    const res = await api('GET', '/groups', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.length >= 1, 'has groups');
  });

  await test('G7: Get group details', async () => {
    const res = await api('GET', `/groups/${groupConvId}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assertEqual(res.data.data.title, 'Test Group', 'title');
    assert(res.data.data.members.length >= 3, 'has members');
  });

  await test('G8: Non-member cannot get group details', async () => {
    const res = await api('GET', `/groups/${groupConvId}`, undefined, agentYToken);
    assertEqual(res.status, 403, 'status');
  });

  suite('Groups API - Messages');

  await test('G9: Send message to group', async () => {
    const res = await api(
      'POST',
      `/groups/${groupConvId}/messages`,
      {
        content: 'Hello group!',
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('G10: Another member sends to group', async () => {
    const res = await api(
      'POST',
      `/groups/${groupConvId}/messages`,
      {
        content: 'Hello from User B!',
      },
      userBToken,
    );
    assertEqual(res.status, 201, 'status');
  });

  await test('G11: Agent sends to group', async () => {
    const res = await api(
      'POST',
      `/groups/${groupConvId}/messages`,
      {
        content: 'Agent X reporting in',
      },
      agentXToken,
    );
    assertEqual(res.status, 201, 'status');
  });

  await test('G12: Non-member cannot send to group', async () => {
    const res = await api(
      'POST',
      `/groups/${groupConvId}/messages`,
      {
        content: 'Unauthorized!',
      },
      agentYToken,
    );
    assertEqual(res.status, 403, 'status');
  });

  await test('G13: Get group message history', async () => {
    const res = await api('GET', `/groups/${groupConvId}/messages`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.data.length >= 3, 'has messages');
  });

  await test('G14: Non-member cannot get group messages', async () => {
    const res = await api('GET', `/groups/${groupConvId}/messages`, undefined, agentYToken);
    assertEqual(res.status, 403, 'status');
  });

  suite('Groups API - Members');

  await test('G15: Owner adds member', async () => {
    const res = await api(
      'POST',
      `/groups/${groupConvId}/members`,
      {
        userId: agentYId,
      },
      userAToken,
    );
    assertEqual(res.status, 201, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('G16: Added member can now send', async () => {
    const res = await api(
      'POST',
      `/groups/${groupConvId}/messages`,
      {
        content: 'Agent Y is here!',
      },
      agentYToken,
    );
    assertEqual(res.status, 201, 'status');
  });

  await test('G17: Non-admin cannot add members', async () => {
    const extra = await createTestUser(`comp_extra_${TS}`, 'Extra User');
    const res = await api(
      'POST',
      `/groups/${groupConvId}/members`,
      {
        userId: extra.id,
      },
      userBToken,
    ); // userB is 'member', not owner/admin
    assertEqual(res.status, 403, 'status');
  });

  await test('G18: Add member missing userId', async () => {
    const res = await api('POST', `/groups/${groupConvId}/members`, {}, userAToken);
    assertEqual(res.status, 400, 'status');
  });

  await test('G19: Add non-existent user as member', async () => {
    const res = await api(
      'POST',
      `/groups/${groupConvId}/members`,
      {
        userId: 'totally_nonexistent',
      },
      userAToken,
    );
    assertEqual(res.status, 404, 'status');
  });

  await test('G20: Member removes self', async () => {
    const res = await api('DELETE', `/groups/${groupConvId}/members/${agentYId}`, undefined, agentYToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('G21: Removed member cannot send', async () => {
    const res = await api(
      'POST',
      `/groups/${groupConvId}/messages`,
      {
        content: 'Should fail',
      },
      agentYToken,
    );
    assertEqual(res.status, 403, 'status');
  });

  await test('G22: Non-admin cannot remove others', async () => {
    // Re-add agentY first
    await api('POST', `/groups/${groupConvId}/members`, { userId: agentYId }, userAToken);
    // userB (member) tries to remove agentY
    const res = await api('DELETE', `/groups/${groupConvId}/members/${agentYId}`, undefined, userBToken);
    assertEqual(res.status, 403, 'status');
  });

  await test('G23: Owner can remove members', async () => {
    const res = await api('DELETE', `/groups/${groupConvId}/members/${agentYId}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
  });

  // ═══════════════════════════════════════════════════════════
  // 6. CONVERSATIONS API
  // ═══════════════════════════════════════════════════════════
  suite('Conversations API');

  await test('CV1: List my conversations', async () => {
    const res = await api('GET', '/conversations', undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.length >= 2, 'has conversations');
  });

  await test('CV2: List with unread counts', async () => {
    const res = await api('GET', '/conversations?withUnread=true', undefined, userBToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    // userB should have unread from userA's messages
    const hasUnread = res.data.data.some((c: any) => c.unreadCount > 0);
    assert(hasUnread, 'has conversations with unread');
  });

  await test('CV3: List unread only', async () => {
    const res = await api('GET', '/conversations?unreadOnly=true', undefined, userBToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    // All returned conversations should have unread > 0
    for (const conv of res.data.data) {
      assert(conv.unreadCount > 0, `conv ${conv.id} should have unread`);
    }
  });

  await test('CV4: Get conversation details', async () => {
    const res = await api('GET', `/conversations/${directConvId}`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
    assert(res.data.data.participants.length >= 2, 'has participants');
  });

  await test('CV5: Get conversation - non-participant', async () => {
    const res = await api('GET', `/conversations/${directConvId}`, undefined, agentYToken);
    assertEqual(res.status, 403, 'status');
  });

  await test('CV6: Get non-existent conversation', async () => {
    const res = await api('GET', '/conversations/nonexistent_conv_id', undefined, userAToken);
    assertEqual(res.status, 404, 'status');
  });

  await test('CV7: Update conversation', async () => {
    const res = await api(
      'PATCH',
      `/conversations/${groupConvId}`,
      {
        title: 'Updated Test Group',
        description: 'Updated description',
      },
      userAToken,
    );
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('CV8: Update conversation - non-participant', async () => {
    const res = await api(
      'PATCH',
      `/conversations/${groupConvId}`,
      {
        title: 'Hacker Title',
      },
      agentYToken,
    );
    assertEqual(res.status, 403, 'status');
  });

  await test('CV9: Mark conversation as read', async () => {
    const res = await api('POST', `/conversations/${directConvId}/read`, undefined, userBToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('CV10: After mark read, unread is 0', async () => {
    const res = await api('GET', '/conversations?withUnread=true', undefined, userBToken);
    const conv = res.data.data.find((c: any) => c.id === directConvId);
    if (conv) {
      assertEqual(conv.unreadCount, 0, 'unread should be 0');
    }
  });

  await test('CV11: Mark read - non-participant', async () => {
    const res = await api('POST', `/conversations/${directConvId}/read`, undefined, agentYToken);
    assertEqual(res.status, 403, 'status');
  });

  await test('CV12: Archive conversation', async () => {
    // Create a temp conversation to archive
    const tempGroup = await api(
      'POST',
      '/groups',
      {
        title: 'Archive Me',
      },
      userAToken,
    );
    assertEqual(tempGroup.status, 201, 'group creation status');
    assert(tempGroup.data?.data?.groupId, 'group creation must return groupId (got 429? check rate limiter)');
    const tempId = tempGroup.data.data.groupId;

    const res = await api('POST', `/conversations/${tempId}/archive`, undefined, userAToken);
    assertEqual(res.status, 200, 'status');
    assert(res.data.ok, 'ok');
  });

  await test('CV13: Archived conversation not in active list', async () => {
    const res = await api('GET', '/conversations?status=active', undefined, userAToken);
    const archived = res.data.data.find((c: any) => c.title === 'Archive Me');
    assert(!archived, 'archived should not appear in active list');
  });

  // ═══════════════════════════════════════════════════════════
  // 7. EDGE CASES & ERROR HANDLING
  // ═══════════════════════════════════════════════════════════
  suite('Auth Edge Cases');

  await test('E1: Request without auth header', async () => {
    const res = await api('GET', '/conversations');
    assertEqual(res.status, 401, 'status');
  });

  await test('E2: Request with invalid token', async () => {
    const res = await api('GET', '/conversations', undefined, 'invalid.token.here');
    assertEqual(res.status, 401, 'status');
  });

  await test('E3: Request with malformed Bearer', async () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: 'NotBearer xyz',
    };
    const res = await fetch(`${BASE}/api/conversations`, { headers });
    assertEqual(res.status, 401, 'status');
  });

  suite('Registration Edge Cases');

  await test('E4: Duplicate username from same registration type', async () => {
    const username = `dup_test_${TS}`;
    // First register
    await api('POST', '/users/register', {
      username,
      displayName: 'First',
      role: 'human',
      password: 'test123',
    });
    // Second register with same username should fail or return existing
    const res2 = await api('POST', '/users/register', {
      username,
      displayName: 'Second',
      role: 'human',
      password: 'test123',
    });
    // Depends on implementation - may return existing user or error
    assert(
      res2.status === 200 || res2.status === 201 || res2.status === 409,
      `status should be 200/201/409, got ${res2.status}`,
    );
  });

  await test('E5: Username with max length (32 chars)', async () => {
    const res = await api(
      'POST',
      '/register',
      {
        type: 'agent',
        username: 'a'.repeat(32),
        displayName: 'Max Length User',
      },
      userAToken,
    );
    // Should succeed (32 is the limit)
    assert(res.status === 200 || res.status === 201, `expected success, got ${res.status}`);
  });

  await test('E6: Username over max length (33 chars)', async () => {
    const res = await api(
      'POST',
      '/register',
      {
        type: 'agent',
        username: 'b'.repeat(33),
        displayName: 'Over Max Length',
      },
      userAToken,
    );
    assertEqual(res.status, 400, 'status');
  });

  suite('Data Integrity');

  await test('E7: Message count consistent after operations', async () => {
    const history = await api('GET', `/messages/${directConvId}?limit=100`, undefined, userAToken);
    const total = history.data.meta.total;
    const actual = history.data.data.length;
    // total might include deleted, but data should only have non-deleted
    assert(actual <= total, `actual ${actual} should be <= total ${total}`);
  });

  await test('E8: Conversation participant list accurate', async () => {
    const conv = await api('GET', `/conversations/${groupConvId}`, undefined, userAToken);
    const participants = conv.data.data.participants;
    // Each participant should have user info
    for (const p of participants) {
      assert(p.user.id, 'participant has user id');
      assert(p.user.username, 'participant has username');
      assert(p.role, 'participant has role');
    }
  });

  await test('E9: Workspace data isolation', async () => {
    // Workspace 1 messages shouldn't appear in workspace 2
    const ws1 = await api('GET', `/workspace/ws_${TS}_1/messages`, undefined, userAToken);
    const ws2 = await api('GET', `/workspace/ws_${TS}_2/messages`, undefined, userAToken);
    // ws2 was created without agent and no messages sent
    assertEqual(ws2.data.data.length, 0, 'ws2 should have 0 messages');
  });

  // ═══════════════════════════════════════════════════════════
  // 8. CROSS-API INTEGRATION
  // ═══════════════════════════════════════════════════════════
  suite('Cross-API Integration');

  await test('I1: Direct API → Conversations API consistency', async () => {
    // After using direct API, conversation should appear in conversations list
    const convList = await api('GET', '/conversations', undefined, userAToken);
    const directConvs = convList.data.data.filter((c: any) => c.type === 'direct');
    assert(directConvs.length >= 1, 'has direct conversations');
  });

  await test('I2: Groups API → Conversations API consistency', async () => {
    const convList = await api('GET', '/conversations', undefined, userAToken);
    const groupConvs = convList.data.data.filter((c: any) => c.type === 'group');
    assert(groupConvs.length >= 1, 'has group conversations');
  });

  await test('I3: Workspace API → Messages API consistency', async () => {
    // Send message via workspace, then query via messages API
    // First get workspace conversation ID
    const wsConv = await api('GET', `/workspace/ws_${TS}_1/conversation`, undefined, userAToken);
    const wsConvId = wsConv.data.data.id;

    // Get agent token from workspace
    const agents = await api('GET', `/workspace/ws_${TS}_1/agents`, undefined, userAToken);
    const agentUserId = agents.data.data[0].userId;

    // Generate fresh token for agent
    const tokenRes = await api('POST', `/workspace/ws_${TS}_1/agents/${agentUserId}/token`, {}, userAToken);
    const wsAgentToken = tokenRes.data.data.token;

    // Send message as agent
    const sendRes = await api(
      'POST',
      `/messages/${wsConvId}`,
      {
        content: 'Message from workspace agent',
      },
      wsAgentToken,
    );
    assertEqual(sendRes.status, 201, 'send status');

    // Verify in workspace messages
    const wsMessages = await api('GET', `/workspace/ws_${TS}_1/messages`, undefined, userAToken);
    assert(wsMessages.data.data.length >= 1, 'message appears in workspace');
  });

  await test('I4: Full lifecycle: register → send → read → unread', async () => {
    // Create a fresh user first (register endpoint updates the calling user)
    const fresh = await createTestUser(`lifecycle_base_${TS}`, 'Lifecycle Base', 'human');

    // Register this fresh user as an agent via v0.2.0 register endpoint
    const regRes = await api(
      'POST',
      '/register',
      {
        type: 'agent',
        username: `lifecycle_${TS}`,
        displayName: 'Lifecycle Agent',
        capabilities: ['lifecycle'],
      },
      fresh.token,
    );
    assert(regRes.data.ok, `register failed: ${JSON.stringify(regRes.data)}`);
    const agentToken = regRes.data.data.token;
    const agentId = regRes.data.data.imUserId;

    // Create direct conversation via direct API
    const sendRes = await api(
      'POST',
      `/direct/${userAId}/messages`,
      {
        content: 'Lifecycle test message',
      },
      agentToken,
    );
    assertEqual(sendRes.status, 201, 'send ok');
    const convId = sendRes.data.data.conversationId;

    // Check unread for userA
    const meRes = await api('GET', '/me', undefined, userAToken);
    assert(meRes.data.data.stats.unreadCount >= 1, 'has unread');

    // Mark as read
    await api('POST', `/conversations/${convId}/read`, undefined, userAToken);

    // Check contacts for agent
    const contacts = await api('GET', '/contacts', undefined, agentToken);
    assert(contacts.data.ok, 'contacts ok');
    const found = contacts.data.data.find((c: any) => c.userId === userAId);
    assert(found, "userA is in agent's contacts");
  });

  // ═══════════════════════════════════════════════════════════
  // Results
  // ═══════════════════════════════════════════════════════════
  suiteResults.push({ name: currentSuite, passed: suiteP, failed: suiteF });

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`Total: ${passed + failed} tests | ✅ ${passed} passed | ❌ ${failed} failed`);

  if (failures.length > 0) {
    console.log('\n❌ Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }

  console.log('\n📊 Suite Summary:');
  for (const s of suiteResults) {
    const icon = s.failed === 0 ? '✅' : '❌';
    console.log(`   ${icon} ${s.name}: ${s.passed}/${s.passed + s.failed}`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`\nTime: ${elapsed}ms`);
  console.log('═══════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

const startTime = Date.now();
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
