/**
 * Prismer IM Server Integration Tests
 *
 * Tests P0 (Workspace Bridge) and P1 (@Mention, Response Coordinator) features.
 *
 * Run with: npx tsx src/im/tests/integration.test.ts
 */

const IM_SERVER_URL = process.env.IM_SERVER_URL || 'http://localhost:3200';

// ─── Test Utilities ───────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`✅ ${name}`);
  } catch (err) {
    results.push({
      name,
      passed: false,
      error: (err as Error).message,
      duration: Date.now() - start,
    });
    console.log(`❌ ${name}: ${(err as Error).message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(str: string, substr: string, message: string): void {
  if (!str.includes(substr)) {
    throw new Error(`${message}: "${str}" does not include "${substr}"`);
  }
}

// ─── API Helpers ──────────────────────────────────────────────

async function api<T>(
  method: string,
  path: string,
  body?: any,
  token?: string
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(`${IM_SERVER_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return resp.json();
}

// ─── Test Suite ───────────────────────────────────────────────

async function runTests() {
  console.log('=== Prismer IM Integration Tests ===\n');
  console.log(`Server: ${IM_SERVER_URL}\n`);

  // Generate unique IDs for this test run
  const testId = Date.now().toString(36);
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let agentToken: string;
  let agentId: string;
  let conversationId: string;

  // ─── Health Check ─────────────────────────────────────────────

  await test('Health check returns ok', async () => {
    const resp = await api('GET', '/api/health');
    assert(resp.ok === true, 'Health check failed');
  });

  // ─── User Registration ────────────────────────────────────────

  await test('Register admin user', async () => {
    const resp = await api<any>('POST', '/api/users/register', {
      username: `admin_${testId}`,
      displayName: 'Test Admin',
      role: 'admin',
    });
    if (!resp.ok && resp.error?.includes('already taken')) {
      // Login instead
      const loginResp = await api<any>('POST', '/api/users/login', {
        username: `admin_${testId}`,
      });
      assert(loginResp.ok, loginResp.error || 'Login failed');
      adminToken = loginResp.data.token;
    } else {
      assert(resp.ok, resp.error || 'Registration failed');
      adminToken = resp.data.token;
    }
    assert(!!adminToken, 'No token received');
  });

  // ─── P0: Workspace Initialization ─────────────────────────────

  await test('P0: Initialize workspace with user and agent', async () => {
    const resp = await api<any>('POST', '/api/workspace/init', {
      workspaceId: `ws_${testId}`,
      userId: `user_${testId}`,
      userDisplayName: 'Test User',
      agentName: `agent_${testId}`,
      agentDisplayName: 'Test Agent',
      agentType: 'assistant',
      agentCapabilities: ['code_review', 'paper_search'],
    }, adminToken);

    assert(resp.ok, resp.error || 'Workspace init failed');
    assert(!!resp.data.conversationId, 'No conversation ID');
    assert(!!resp.data.user.token, 'No user token');
    assert(!!resp.data.agent?.token, 'No agent token');

    conversationId = resp.data.conversationId;
    userToken = resp.data.user.token;
    userId = resp.data.user.imUserId;
    agentToken = resp.data.agent.token;
    agentId = resp.data.agent.agentUserId;
  });

  await test('P0: List workspace agents', async () => {
    const resp = await api<any[]>('GET', `/api/workspace/ws_${testId}/agents`, null, userToken);
    assert(resp.ok, resp.error || 'List agents failed');
    assert(Array.isArray(resp.data), 'Data should be array');
    assert(resp.data.length >= 1, 'Should have at least 1 agent');

    const agent = resp.data.find((a: any) => a.username === `agent_${testId}`);
    assert(!!agent, 'Agent not found');
    assert(agent.capabilities.includes('code_review'), 'Missing capability');
  });

  await test('P0: Get workspace conversation', async () => {
    const resp = await api<any>('GET', `/api/workspace/ws_${testId}/conversation`, null, userToken);
    assert(resp.ok, resp.error || 'Get conversation failed');
    assertEqual(resp.data.id, conversationId, 'Conversation ID mismatch');
  });

  await test('P0: Generate new agent token', async () => {
    const resp = await api<any>('POST', `/api/workspace/ws_${testId}/agents/${agentId}/token`, null, userToken);
    assert(resp.ok, resp.error || 'Token generation failed');
    assert(!!resp.data.token, 'No token in response');
    assertEqual(resp.data.expiresIn, '7d', 'Token expiry mismatch');
  });

  // ─── P1: @Mention System ──────────────────────────────────────

  await test('P1: Send message with @mention - explicit routing', async () => {
    const resp = await api<any>('POST', `/api/messages/${conversationId}`, {
      content: `@agent_${testId} 帮我审查代码`,
      type: 'text',
    }, userToken);

    assert(resp.ok, resp.error || 'Send message failed');
    assertEqual(resp.data.routing?.mode, 'explicit', 'Routing mode should be explicit');
    assert(resp.data.routing?.targets?.length === 1, 'Should target 1 agent');
    assertEqual(resp.data.routing.targets[0].userId, agentId, 'Target should be the agent');
  });

  await test('P1: Send question without @mention - capability routing', async () => {
    const resp = await api<any>('POST', `/api/messages/${conversationId}`, {
      content: '帮我搜索论文',
      type: 'text',
    }, userToken);

    assert(resp.ok, resp.error || 'Send message failed');
    assertEqual(resp.data.routing?.mode, 'capability', 'Routing mode should be capability');
    assert(resp.data.routing?.targets?.length >= 1, 'Should have targets');
  });

  await test('P1: Send regular message - broadcast routing', async () => {
    const resp = await api<any>('POST', `/api/messages/${conversationId}`, {
      content: '大家好',
      type: 'text',
    }, userToken);

    assert(resp.ok, resp.error || 'Send message failed');
    assertEqual(resp.data.routing?.mode, 'broadcast', 'Routing mode should be broadcast');
    assertEqual(resp.data.routing?.targets?.length, 0, 'Broadcast should have no specific targets');
  });

  await test('P1: Mention autocomplete suggestions', async () => {
    const resp = await api<any[]>(
      'GET',
      `/api/workspace/mentions/autocomplete?conversationId=${conversationId}&query=agent`,
      null,
      userToken
    );

    assert(resp.ok, resp.error || 'Autocomplete failed');
    assert(Array.isArray(resp.data), 'Data should be array');
    assert(resp.data.length >= 1, 'Should have suggestions');

    const suggestion = resp.data.find((s: any) => s.username.includes('agent'));
    assert(!!suggestion, 'Agent suggestion not found');
  });

  await test('P1: Message metadata includes mentions and routing', async () => {
    const resp = await api<any>('GET', `/api/messages/${conversationId}?limit=5`, null, userToken);
    assert(resp.ok, resp.error || 'Get messages failed');
    assert(Array.isArray(resp.data), 'Data should be array');

    // Find the explicit mention message
    const mentionMsg = resp.data.find((m: any) =>
      m.content.includes('@agent_')
    );
    assert(!!mentionMsg, 'Mention message not found');

    const metadata = typeof mentionMsg.metadata === 'string'
      ? JSON.parse(mentionMsg.metadata)
      : mentionMsg.metadata;

    assert(Array.isArray(metadata.mentions), 'Metadata should have mentions array');
    assert(metadata.mentions.length === 1, 'Should have 1 mention');
    assertEqual(metadata.routingMode, 'explicit', 'Should have explicit routing mode');
  });

  // ─── Agent sending messages ───────────────────────────────────

  await test('P1: Agent sends message - no routing (prevents loops)', async () => {
    const resp = await api<any>('POST', `/api/messages/${conversationId}`, {
      content: '我收到了你的请求，正在处理中...',
      type: 'text',
    }, agentToken);

    assert(resp.ok, resp.error || 'Agent message failed');
    // Agent messages should have no routing (to prevent loops)
    assert(!resp.data.routing || resp.data.routing.mode === 'none', 'Agent messages should not trigger routing');
  });

  // ─── Additional workspace operations ──────────────────────────

  await test('P0: Add another agent to workspace', async () => {
    const resp = await api<any>('POST', `/api/workspace/ws_${testId}/agents`, {
      agentName: `agent2_${testId}`,
      agentDisplayName: 'Second Agent',
      agentType: 'specialist',
      capabilities: ['data_analysis'],
    }, userToken);

    assert(resp.ok, resp.error || 'Add agent failed');
    assert(!!resp.data.token, 'No token for new agent');
    assert(!!resp.data.agentUserId, 'No agent ID');
  });

  await test('P0: Verify multiple agents in workspace', async () => {
    const resp = await api<any[]>('GET', `/api/workspace/ws_${testId}/agents`, null, userToken);
    assert(resp.ok, resp.error || 'List agents failed');
    assert(resp.data.length >= 2, 'Should have at least 2 agents');
  });

  // ─── Print Results ────────────────────────────────────────────

  console.log('\n=== Test Summary ===\n');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`Total: ${results.length} tests`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Duration: ${totalTime}ms`);

  if (failed > 0) {
    console.log('\n=== Failed Tests ===\n');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`❌ ${r.name}`);
      console.log(`   Error: ${r.error}`);
    }
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
  }
}

// Run tests
runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
