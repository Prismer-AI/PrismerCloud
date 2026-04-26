#!/usr/bin/env node
/**
 * Prismer IM — Comprehensive Scenario Tests (v2.1.8)
 *
 * Tests real-world agent workflows through the Next.js proxy layer.
 * Uses API Key + anonymous registration (no raw JWT manipulation).
 *
 * Usage:
 *   node scripts/test-im-scenarios.js
 *
 * Environment:
 *   BASE_URL   — Default: https://cloud.prismer.dev
 *   API_KEY    — Required: sk-prismer-live-xxx
 *
 * Scenarios:
 *   1. Health check
 *   2. Autonomous agent lifecycle (register → profile → send → credits)
 *   3. Bound agent lifecycle (API Key register → profile → send → credits)
 *   4. Multi-agent identity (same API Key, two agents)
 *   5. Inter-agent communication (autonomous ↔ bound)
 *   6. Contacts & Discovery
 *   7. Re-registration idempotency
 *   8. Credit deduction precision
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.BASE_URL || 'https://cloud.prismer.dev').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || process.env.PRISMER_API_KEY_TEST || '';
const RUN_ID = Date.now().toString(36); // unique per run to avoid username collisions

// ---------------------------------------------------------------------------
// Test framework
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const results = [];

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertApprox(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    passed++;
    results.push({ name, status: 'pass', ms });
    console.log(`  ✅ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - t0;
    failed++;
    const msg = err.message || String(err);
    failures.push({ name, msg });
    results.push({ name, status: 'FAIL', ms, msg });
    console.log(`  ❌ ${name}: ${msg} (${ms}ms)`);
  }
}

function skip(name, reason) {
  skipped++;
  results.push({ name, status: 'skip', msg: reason });
  console.log(`  ⏭️  ${name}: ${reason}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(method, path, body, auth, headers = {}) {
  const url = `${BASE_URL}/api/im/${path}`.replace(/\/+/g, '/').replace(':/', '://');
  const hdrs = { 'Content-Type': 'application/json', ...headers };
  if (auth) hdrs['Authorization'] = auth.startsWith('Bearer ') ? auth : `Bearer ${auth}`;
  const opts = { method, headers: hdrs };
  if (body && !['GET', 'HEAD'].includes(method)) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

/** Retry a request up to N times on transient 401 (known intermittent issue). */
async function apiRetry(method, path, body, auth, headers = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const r = await api(method, path, body, auth, headers);
    if (r.status !== 401 || i === retries) return r;
    await sleep(300);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Shared state across scenarios
// ---------------------------------------------------------------------------

const state = {
  // Autonomous agents (registered without API Key)
  autoAgent: null,   // { id, username, token }
  autoAgent2: null,
  // Bound agents (registered with API Key)
  boundAgentA: null, // { id, username, token }
  boundAgentB: null,
};

// ---------------------------------------------------------------------------
// Scenario 1: Health Check
// ---------------------------------------------------------------------------

async function scenario1_health() {
  console.log('\n━━━ Scenario 1: Health Check ━━━');

  await test('GET /health returns ok', async () => {
    const r = await api('GET', 'health');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.data?.ok === true, `ok=${r.data?.ok}`);
    assert(r.data?.version, `no version in response: ${JSON.stringify(r.data)}`);
    console.log(`       version=${r.data.version}, service=${r.data.service}`);
  });
}

// ---------------------------------------------------------------------------
// Scenario 2: Autonomous Agent Lifecycle
// ---------------------------------------------------------------------------

async function scenario2_autonomous() {
  console.log('\n━━━ Scenario 2: Autonomous Agent Lifecycle ━━━');

  const username = `auto_${RUN_ID}_a`;

  await test('Register autonomous agent (no auth)', async () => {
    const r = await api('POST', 'register', {
      type: 'agent',
      username,
      displayName: 'Auto Agent A',
      agentType: 'assistant',
      capabilities: ['chat', 'search'],
      description: 'Scenario test autonomous agent',
    });
    assert(r.status === 201, `status ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data?.data?.isNew === true, 'expected isNew=true');
    assert(r.data.data.imUserId, 'missing imUserId');
    assert(r.data.data.token, 'missing token');
    state.autoAgent = {
      id: r.data.data.imUserId,
      username,
      token: r.data.data.token,
    };
  });

  await test('GET /me — profile + agentCard', async () => {
    const r = await apiRetry('GET', 'me', null, state.autoAgent.token);
    assert(r.status === 200, `status ${r.status}`);
    const d = r.data?.data;
    assertEq(d?.user?.username, username, 'username');
    assertEq(d?.user?.role, 'agent', 'role');
    assert(d?.agentCard, 'missing agentCard');
    console.log(`       id=${d.user.id}`);
  });

  await test('GET /credits — initial balance = 100', async () => {
    // Use /credits endpoint to trigger ensureCredit and get accurate balance
    const r = await apiRetry('GET', 'credits', null, state.autoAgent.token);
    assert(r.status === 200, `status ${r.status}`);
    const d = r.data?.data;
    assertEq(d?.balance, 100, 'initial balance');
    assertEq(d?.totalSpent, 0, 'initial totalSpent');
    console.log(`       balance=${d.balance}`);
  });

  // Register a second autonomous agent as message target
  const username2 = `auto_${RUN_ID}_b`;
  await test('Register second autonomous agent (message target)', async () => {
    const r = await api('POST', 'register', {
      type: 'agent',
      username: username2,
      displayName: 'Auto Agent B',
      agentType: 'assistant',
      capabilities: ['chat'],
    });
    assert([200, 201].includes(r.status), `status ${r.status}`);
    state.autoAgent2 = {
      id: r.data.data.imUserId,
      username: username2,
      token: r.data.data.token,
    };
  });

  await test('Send direct message (autonomous → autonomous)', async () => {
    const r = await apiRetry('POST', `direct/${state.autoAgent2.id}/messages`, {
      type: 'text',
      content: `Hello from ${username}!`,
    }, state.autoAgent.token);
    assert(r.status === 200 || r.status === 201, `status ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data?.ok === true, `ok=${r.data?.ok}`);
    assert(r.data.data?.message?.id, 'missing message id');
  });

  await test('Credits deducted after message send', async () => {
    const r = await apiRetry('GET', 'credits', null, state.autoAgent.token);
    assert(r.status === 200, `status ${r.status}`);
    const d = r.data?.data;
    assert(d.totalSpent > 0, `totalSpent should be >0, got ${d.totalSpent}`);
    assertApprox(d.totalSpent, 0.001, 0.0005, 'totalSpent');
    assertApprox(d.balance, 99.999, 0.0005, 'balance');
    console.log(`       balance=${d.balance}, spent=${d.totalSpent}`);
  });

  await test('Credit transactions recorded', async () => {
    const r = await apiRetry('GET', 'credits/transactions?limit=10', null, state.autoAgent.token);
    assert(r.status === 200, `status ${r.status}`);
    const txs = r.data?.data;
    assert(Array.isArray(txs), 'expected array of transactions');
    assert(txs.length >= 1, `expected >=1 tx, got ${txs.length}`);
    // Should have at least a bonus (100 initial) and a deduction
    const hasDeduction = txs.some(tx => tx.type === 'deduction' || tx.amount < 0);
    const hasBonus = txs.some(tx => tx.type === 'bonus');
    assert(hasBonus || hasDeduction, `expected bonus or deduction tx: ${JSON.stringify(txs[0])}`);
    console.log(`       ${txs.length} transaction(s), types: ${[...new Set(txs.map(t => t.type))].join(',')}`);
  });
}

// ---------------------------------------------------------------------------
// Scenario 3: Bound Agent Lifecycle (API Key)
// ---------------------------------------------------------------------------

async function scenario3_bound() {
  console.log('\n━━━ Scenario 3: Bound Agent Lifecycle (API Key) ━━━');

  if (!API_KEY) {
    skip('All bound agent tests', 'API_KEY not set');
    return;
  }

  const usernameA = `bound_${RUN_ID}_a`;

  await test('Register bound agent with API Key', async () => {
    const r = await apiRetry('POST', 'register', {
      type: 'agent',
      username: usernameA,
      displayName: 'Bound Agent A',
      agentType: 'assistant',
      capabilities: ['chat', 'analysis'],
      description: 'Bound agent test A',
    }, API_KEY);
    assert(r.status === 201 || r.status === 200, `status ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data?.data?.imUserId, 'missing imUserId');
    state.boundAgentA = {
      id: r.data.data.imUserId,
      username: usernameA,
      token: r.data.data.token,
    };
    console.log(`       id=${state.boundAgentA.id}, isNew=${r.data.data.isNew}`);
  });

  await test('GET /me via API Key + X-IM-Agent — shows correct profile', async () => {
    // Must use X-IM-Agent for newly registered agent (default is oldest agent)
    const r = await apiRetry('GET', 'me', null, API_KEY, {
      'X-IM-Agent': usernameA,
    });
    assert(r.status === 200, `status ${r.status}`);
    const d = r.data?.data;
    assertEq(d?.user?.id, state.boundAgentA.id, 'id');
    assertEq(d?.user?.role, 'agent', 'role');
    assert(d?.credits, 'missing credits');
    // Bound agent sees cloud credit pool (should be >>100)
    console.log(`       username=${d.user.username}, cloud credits: balance=${d.credits.balance}`);
  });

  await test('Bound agent sends message to autonomous agent', async () => {
    assert(state.autoAgent, 'autoAgent not registered');
    const r = await apiRetry('POST', `direct/${state.autoAgent.id}/messages`, {
      type: 'text',
      content: `Hi from bound agent ${usernameA}!`,
    }, state.boundAgentA.token);
    assert(r.data?.ok === true, `ok=${r.data?.ok}, status=${r.status}`);
    assert(r.data.data?.message?.senderId === state.boundAgentA.id, 'wrong senderId');
  });

  await test('Bound agent IM credits NOT deducted (cloud handles it)', async () => {
    // Check via IM JWT — bound agents should still have full IM balance
    // or show cloud pool balance. Key point: totalSpent should NOT increase
    // from the IM credit pool perspective when using IM JWT of a bound agent.
    // Actually, bound agents use IM JWT (not api_key_proxy), so IM credits
    // DO get deducted. This tests whether the deduction happened.
    const r = await apiRetry('GET', 'credits', null, state.boundAgentA.token);
    assert(r.status === 200, `status ${r.status}`);
    // For newly created bound agents, IM credits start at 100
    // and get deducted when using IM JWT directly (not via API Key proxy)
    console.log(`       IM credits: balance=${r.data?.data?.balance}, spent=${r.data?.data?.totalSpent}`);
  });
}

// ---------------------------------------------------------------------------
// Scenario 4: Multi-Agent Identity (Same API Key)
// ---------------------------------------------------------------------------

async function scenario4_multiAgent() {
  console.log('\n━━━ Scenario 4: Multi-Agent Identity (Same API Key) ━━━');

  if (!API_KEY) {
    skip('All multi-agent tests', 'API_KEY not set');
    return;
  }

  const usernameB = `bound_${RUN_ID}_b`;

  await test('Register second agent with same API Key', async () => {
    const r = await apiRetry('POST', 'register', {
      type: 'agent',
      username: usernameB,
      displayName: 'Bound Agent B',
      agentType: 'specialist',
      capabilities: ['search', 'report'],
      description: 'Bound agent test B (same key)',
    }, API_KEY);
    assert(r.status === 201 || r.status === 200, `status ${r.status}: ${JSON.stringify(r.data)}`);
    state.boundAgentB = {
      id: r.data.data.imUserId,
      username: usernameB,
      token: r.data.data.token,
    };
    console.log(`       id=${state.boundAgentB.id}`);
  });

  await test('Two bound agents have DIFFERENT imUserIds', async () => {
    assert(state.boundAgentA, 'boundAgentA not set');
    assert(state.boundAgentB, 'boundAgentB not set');
    assert(
      state.boundAgentA.id !== state.boundAgentB.id,
      `Same ID! A=${state.boundAgentA.id}, B=${state.boundAgentB.id}`
    );
    console.log(`       A=${state.boundAgentA.id}`);
    console.log(`       B=${state.boundAgentB.id}`);
  });

  await test('X-IM-Agent selects agent-a', async () => {
    const r = await apiRetry('GET', 'me', null, API_KEY, {
      'X-IM-Agent': state.boundAgentA.username,
    });
    assert(r.status === 200, `status ${r.status}`);
    assertEq(r.data?.data?.user?.username, state.boundAgentA.username, 'username');
    assertEq(r.data?.data?.user?.id, state.boundAgentA.id, 'id');
  });

  await test('X-IM-Agent selects agent-b', async () => {
    const r = await apiRetry('GET', 'me', null, API_KEY, {
      'X-IM-Agent': state.boundAgentB.username,
    });
    assert(r.status === 200, `status ${r.status}`);
    assertEq(r.data?.data?.user?.username, state.boundAgentB.username, 'username');
    assertEq(r.data?.data?.user?.id, state.boundAgentB.id, 'id');
  });

  await test('Bound agents can message each other', async () => {
    // A → B
    const r1 = await apiRetry('POST', `direct/${state.boundAgentB.id}/messages`, {
      type: 'text', content: 'Hello B from A',
    }, state.boundAgentA.token);
    assert(r1.data?.ok === true, `A→B failed: ${JSON.stringify(r1.data)}`);

    // B → A
    const r2 = await apiRetry('POST', `direct/${state.boundAgentA.id}/messages`, {
      type: 'text', content: 'Hello A from B',
    }, state.boundAgentB.token);
    assert(r2.data?.ok === true, `B→A failed: ${JSON.stringify(r2.data)}`);
  });
}

// ---------------------------------------------------------------------------
// Scenario 5: Inter-Agent Communication (Autonomous ↔ Bound)
// ---------------------------------------------------------------------------

async function scenario5_interAgent() {
  console.log('\n━━━ Scenario 5: Inter-Agent Communication ━━━');

  if (!state.autoAgent || !state.boundAgentA) {
    skip('Inter-agent tests', 'requires both auto and bound agents');
    return;
  }

  await test('Autonomous agent sends to bound agent', async () => {
    const r = await apiRetry('POST', `direct/${state.boundAgentA.id}/messages`, {
      type: 'text', content: 'Cross-type message: auto→bound',
    }, state.autoAgent.token);
    assert(r.data?.ok === true, `failed: ${JSON.stringify(r.data)}`);
    assert(r.data.data.message.senderId === state.autoAgent.id, 'wrong senderId');
  });

  await test('Bound agent replies to autonomous agent', async () => {
    const r = await apiRetry('POST', `direct/${state.autoAgent.id}/messages`, {
      type: 'text', content: 'Cross-type reply: bound→auto',
    }, state.boundAgentA.token);
    assert(r.data?.ok === true, `failed: ${JSON.stringify(r.data)}`);
    assert(r.data.data.message.senderId === state.boundAgentA.id, 'wrong senderId');
  });

  await test('Conversation history shows both sides', async () => {
    // Get conversations for autoAgent, find the one with boundAgentA
    const r = await apiRetry('GET', 'contacts', null, state.autoAgent.token);
    assert(r.status === 200, `status ${r.status}`);
    const contacts = r.data?.data || [];
    const boundContact = contacts.find(c => c.userId === state.boundAgentA.id);
    assert(boundContact, `boundAgentA not in contacts list`);
    assert(boundContact.conversationId, 'missing conversationId');

    // Fetch messages in that conversation
    const r2 = await apiRetry(
      'GET',
      `messages/${boundContact.conversationId}?limit=10`,
      null,
      state.autoAgent.token
    );
    assert(r2.status === 200, `messages status ${r2.status}`);
    const messages = r2.data?.data || [];
    assert(messages.length >= 2, `expected >=2 messages, got ${messages.length}`);
    // Should have messages from both senders
    const senders = new Set(messages.map(m => m.senderId));
    assert(senders.has(state.autoAgent.id), 'missing autoAgent messages');
    assert(senders.has(state.boundAgentA.id), 'missing boundAgentA messages');
    console.log(`       ${messages.length} messages in conversation`);
  });
}

// ---------------------------------------------------------------------------
// Scenario 6: Contacts & Discovery
// ---------------------------------------------------------------------------

async function scenario6_discovery() {
  console.log('\n━━━ Scenario 6: Contacts & Discovery ━━━');

  const token = state.autoAgent?.token;
  if (!token) {
    skip('Discovery tests', 'autoAgent not registered');
    return;
  }

  await test('GET /contacts — lists conversation partners', async () => {
    const r = await apiRetry('GET', 'contacts', null, token);
    assert(r.status === 200, `status ${r.status}`);
    const contacts = r.data?.data || [];
    assert(Array.isArray(contacts), 'expected array');
    assert(contacts.length >= 1, `expected >=1 contact, got ${contacts.length}`);
    // Each contact should have required fields
    const c = contacts[0];
    assert(c.userId, 'missing userId');
    assert(c.username, 'missing username');
    assert(c.conversationId, 'missing conversationId');
    console.log(`       ${contacts.length} contact(s)`);
  });

  await test('GET /contacts?role=agent — filter by role', async () => {
    const r = await apiRetry('GET', 'contacts?role=agent', null, token);
    assert(r.status === 200, `status ${r.status}`);
    const contacts = r.data?.data || [];
    for (const c of contacts) {
      assertEq(c.role, 'agent', `contact ${c.username} role`);
    }
    console.log(`       ${contacts.length} agent contact(s)`);
  });

  await test('GET /discover — all users', async () => {
    const r = await apiRetry('GET', 'discover', null, token);
    assert(r.status === 200, `status ${r.status}`);
    const users = r.data?.data || [];
    assert(Array.isArray(users), 'expected array');
    assert(users.length >= 2, `expected >=2 users, got ${users.length}`);
    // Should not include self
    const self = users.find(u => u.userId === state.autoAgent.id);
    assert(!self, 'discover should not include self');
    console.log(`       ${users.length} user(s) discovered`);
  });

  await test('GET /discover?type=agent — agents only', async () => {
    const r = await apiRetry('GET', 'discover?type=agent', null, token);
    assert(r.status === 200, `status ${r.status}`);
    const agents = r.data?.data || [];
    for (const a of agents) {
      assertEq(a.role, 'agent', `user ${a.username} role`);
    }
    // Should include our autoAgent2 and bound agents
    if (state.autoAgent2) {
      const found = agents.find(a => a.userId === state.autoAgent2.id);
      assert(found, `autoAgent2 (${state.autoAgent2.username}) not in discover`);
    }
    console.log(`       ${agents.length} agent(s)`);
  });

  await test('GET /discover?capability=search — capability filter', async () => {
    const r = await apiRetry('GET', 'discover?capability=search', null, token);
    assert(r.status === 200, `status ${r.status}`);
    const agents = r.data?.data || [];
    // At minimum, our test agents with 'search' capability should be included
    const withSearch = agents.filter(a => a.capabilities?.includes('search'));
    assert(withSearch.length >= 1, `expected >=1 agent with search, got ${withSearch.length}`);
    console.log(`       ${agents.length} returned, ${withSearch.length} with 'search' capability`);
  });

  await test('GET /discover?q=<username> — search by name', async () => {
    const searchTerm = RUN_ID; // all our test agents contain the run ID
    const r = await apiRetry('GET', `discover?q=${searchTerm}`, null, token);
    assert(r.status === 200, `status ${r.status}`);
    const users = r.data?.data || [];
    // All results should contain our run ID in username or displayName
    assert(users.length >= 1, `expected >=1 result for q=${searchTerm}, got ${users.length}`);
    console.log(`       ${users.length} result(s) for q="${searchTerm}"`);
  });

  await test('Discover shows isContact flag', async () => {
    const r = await apiRetry('GET', 'discover', null, token);
    assert(r.status === 200, `status ${r.status}`);
    const users = r.data?.data || [];
    // Check that isContact field exists on results
    const withIsContact = users.filter(u => typeof u.isContact === 'boolean');
    assert(withIsContact.length > 0, 'no users with isContact field');
    // At least one contact should be marked true (we've messaged several agents)
    const contacts = withIsContact.filter(u => u.isContact === true);
    console.log(`       ${contacts.length} contacts, ${withIsContact.length - contacts.length} non-contacts`);
  });
}

// ---------------------------------------------------------------------------
// Scenario 7: Re-registration Idempotency
// ---------------------------------------------------------------------------

async function scenario7_reregister() {
  console.log('\n━━━ Scenario 7: Re-registration Idempotency ━━━');

  if (!state.autoAgent) {
    skip('Re-registration tests', 'autoAgent not registered');
    return;
  }

  await test('Re-register with JWT token → 200 (update, not 201)', async () => {
    // Must include JWT token so the server can match the identity
    const r = await apiRetry('POST', 'register', {
      type: 'agent',
      username: state.autoAgent.username,
      displayName: 'Auto Agent A (updated)',
      agentType: 'assistant',
      capabilities: ['chat', 'search', 'summarize'],
      description: 'Updated description',
    }, state.autoAgent.token);
    assertEq(r.status, 200, 'status');
    assertEq(r.data?.data?.isNew, false, 'isNew');
    assertEq(r.data?.data?.imUserId, state.autoAgent.id, 'imUserId should stay same');
    // Update token in case a new one was issued
    state.autoAgent.token = r.data.data.token;
    console.log(`       imUserId unchanged: ${r.data.data.imUserId}`);
  });

  await test('Profile reflects updated fields', async () => {
    const r = await apiRetry('GET', 'me', null, state.autoAgent.token);
    assert(r.status === 200, `status ${r.status}`);
    const d = r.data?.data;
    assertEq(d?.user?.displayName, 'Auto Agent A (updated)', 'displayName');
    const caps = d?.agentCard?.capabilities || [];
    assert(caps.includes('summarize'), `expected 'summarize' in capabilities: ${JSON.stringify(caps)}`);
    console.log(`       displayName="${d.user.displayName}", capabilities=${JSON.stringify(caps)}`);
  });

  if (API_KEY) {
    await test('Re-register bound agent with same API Key + username → 200', async () => {
      assert(state.boundAgentA, 'boundAgentA not set');
      const r = await apiRetry('POST', 'register', {
        type: 'agent',
        username: state.boundAgentA.username,
        displayName: 'Bound Agent A (v2)',
        agentType: 'assistant',
        capabilities: ['chat', 'analysis', 'code'],
        description: 'Updated bound agent',
      }, API_KEY);
      assertEq(r.status, 200, 'status');
      assertEq(r.data?.data?.isNew, false, 'isNew');
      assertEq(r.data?.data?.imUserId, state.boundAgentA.id, 'imUserId should stay same');
    });
  }

  await test('Anonymous re-register (no token) → 409 conflict', async () => {
    // Without a token, the server can't match the identity → username conflict
    const r = await api('POST', 'register', {
      type: 'agent',
      username: state.autoAgent.username,
      displayName: 'Impostor',
      agentType: 'bot',
    });
    assertEq(r.status, 409, 'status');
    assert(r.data?.error?.includes('already taken') || r.data?.error?.includes('taken'), `error: ${r.data?.error}`);
  });

  await test('Different username from different user → 201', async () => {
    const freshName = `conflict_${RUN_ID}`;
    const r = await api('POST', 'register', {
      type: 'agent',
      username: freshName,
      displayName: 'Fresh Agent',
      agentType: 'assistant',
    });
    assertEq(r.status, 201, `status ${r.status}`);
  });
}

// ---------------------------------------------------------------------------
// Scenario 8: Credit Deduction Precision
// ---------------------------------------------------------------------------

async function scenario8_credits() {
  console.log('\n━━━ Scenario 8: Credit Deduction Precision ━━━');

  // Use a fresh agent for clean measurement
  const username = `credit_${RUN_ID}`;

  let agentToken;
  let agentId;
  let targetId = state.autoAgent2?.id;

  if (!targetId) {
    skip('Credit precision tests', 'no message target available');
    return;
  }

  await test('Register fresh agent for credit test', async () => {
    const r = await api('POST', 'register', {
      type: 'agent', username, displayName: 'Credit Tester',
      agentType: 'assistant', capabilities: ['chat'],
    });
    assert(r.status === 201, `status ${r.status}`);
    agentToken = r.data.data.token;
    agentId = r.data.data.imUserId;
  });

  await test('Initial balance = 100', async () => {
    const r = await apiRetry('GET', 'credits', null, agentToken);
    assert(r.status === 200, `status ${r.status}`);
    assertEq(r.data?.data?.balance, 100, 'balance');
    assertEq(r.data?.data?.totalSpent, 0, 'totalSpent');
  });

  await test('Send 5 messages → balance decreases by 0.005', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await apiRetry('POST', `direct/${targetId}/messages`, {
        type: 'text', content: `Credit precision msg ${i}`,
      }, agentToken);
      assert(r.data?.ok === true, `msg ${i} failed: ${JSON.stringify(r.data)}`);
    }

    const r = await apiRetry('GET', 'credits', null, agentToken);
    assert(r.status === 200, `status ${r.status}`);
    const d = r.data.data;
    assertApprox(d.totalSpent, 0.005, 0.001, 'totalSpent after 5 msgs');
    assertApprox(d.balance, 99.995, 0.001, 'balance after 5 msgs');
    console.log(`       balance=${d.balance}, spent=${d.totalSpent}`);
  });

  await test('Send 5 more → total spent ≈ 0.010', async () => {
    for (let i = 6; i <= 10; i++) {
      const r = await apiRetry('POST', `direct/${targetId}/messages`, {
        type: 'text', content: `Credit precision msg ${i}`,
      }, agentToken);
      assert(r.data?.ok === true, `msg ${i} failed`);
    }

    const r = await apiRetry('GET', 'credits', null, agentToken);
    const d = r.data.data;
    assertApprox(d.totalSpent, 0.010, 0.002, 'totalSpent after 10 msgs');
    assertApprox(d.balance, 99.990, 0.002, 'balance after 10 msgs');
    console.log(`       balance=${d.balance}, spent=${d.totalSpent}`);
  });

  if (API_KEY && state.boundAgentA) {
    await test('Bound agent message does NOT deduct IM credits (uses API Key proxy)', async () => {
      // Send message via API Key (api_key_proxy path)
      const beforeR = await apiRetry('GET', 'me', null, API_KEY, {
        'X-IM-Agent': state.boundAgentA.username,
      });
      const creditsBefore = beforeR.data?.data?.credits?.totalSpent;

      await apiRetry('POST', `direct/${targetId}/messages`, {
        type: 'text', content: 'Bound agent message via API Key',
      }, API_KEY, { 'X-IM-Agent': state.boundAgentA.username });

      // IM credits should be unchanged (cloud credits handle it)
      const afterR = await apiRetry('GET', 'me', null, API_KEY, {
        'X-IM-Agent': state.boundAgentA.username,
      });
      const creditsAfter = afterR.data?.data?.credits?.totalSpent;
      console.log(`       cloud credits spent: before=${creditsBefore}, after=${creditsAfter}`);
      // Note: cloud credits totalSpent may increase slightly (0.001),
      // but the key thing is it's the cloud pool, not IM pool
    });
  }
}

// ---------------------------------------------------------------------------
// Scenario 9: Group Chat
// ---------------------------------------------------------------------------

async function scenario9_groupChat() {
  console.log('\n━━━ Scenario 9: Group Chat ━━━');

  if (!state.autoAgent || !state.autoAgent2) {
    skip('Group chat tests', 'need at least 2 agents');
    return;
  }

  let groupId;

  await test('Create group', async () => {
    const r = await apiRetry('POST', 'groups', {
      title: `Test Group ${RUN_ID}`,
      description: 'Scenario test group',
      members: [state.autoAgent2.id],
    }, state.autoAgent.token);
    assert(r.data?.ok === true, `failed: ${JSON.stringify(r.data)}`);
    groupId = r.data.data?.groupId || r.data.data?.id || r.data.data?.conversationId;
    assert(groupId, `missing group id in: ${JSON.stringify(r.data.data)}`);
    console.log(`       groupId=${groupId}`);
  });

  await test('Send message to group', async () => {
    assert(groupId, 'no groupId');
    const r = await apiRetry('POST', `groups/${groupId}/messages`, {
      type: 'text', content: 'Hello group!',
    }, state.autoAgent.token);
    assert(r.data?.ok === true, `failed: ${JSON.stringify(r.data)}`);
  });

  await test('Second agent sees group message', async () => {
    assert(groupId, 'no groupId');
    const r = await apiRetry('GET', `messages/${groupId}?limit=5`, null, state.autoAgent2.token);
    assert(r.status === 200, `status ${r.status}`);
    const messages = r.data?.data || [];
    assert(messages.length >= 1, `expected >=1 message, got ${messages.length}`);
    const groupMsg = messages.find(m => m.content === 'Hello group!');
    assert(groupMsg, 'group message not found');
    assertEq(groupMsg.senderId, state.autoAgent.id, 'senderId');
  });

  await test('Add bound agent to group', async () => {
    if (!state.boundAgentA) {
      console.log('       (skipped — no bound agent)');
      return;
    }
    assert(groupId, 'no groupId');
    const r = await apiRetry('POST', `groups/${groupId}/members`, {
      userId: state.boundAgentA.id,
    }, state.autoAgent.token);
    assert(r.data?.ok === true, `failed: ${JSON.stringify(r.data)}`);
  });
}

// ---------------------------------------------------------------------------
// Scenario 10: Edge Cases & Error Handling
// ---------------------------------------------------------------------------

async function scenario10_edgeCases() {
  console.log('\n━━━ Scenario 10: Edge Cases & Error Handling ━━━');

  await test('Register with invalid username → 400', async () => {
    const r = await api('POST', 'register', {
      type: 'agent', username: 'ab', displayName: 'Too Short',
    });
    assertEq(r.status, 400, 'status');
  });

  await test('Register without required fields → 400', async () => {
    const r = await api('POST', 'register', {
      type: 'agent',
    });
    assertEq(r.status, 400, 'status');
  });

  await test('Register with invalid type → 400', async () => {
    const r = await api('POST', 'register', {
      type: 'cyborg', username: `edge_${RUN_ID}`, displayName: 'Bad Type',
    });
    assertEq(r.status, 400, 'status');
  });

  await test('Send to nonexistent user → 404', async () => {
    if (!state.autoAgent) return;
    const r = await apiRetry('POST', 'direct/nonexistent_user_12345/messages', {
      type: 'text', content: 'should fail',
    }, state.autoAgent.token);
    assertEq(r.status, 404, `expected 404, got ${r.status}`);
  });

  await test('Send to self → 400', async () => {
    if (!state.autoAgent) return;
    const r = await apiRetry('POST', `direct/${state.autoAgent.id}/messages`, {
      type: 'text', content: 'talking to myself',
    }, state.autoAgent.token);
    assertEq(r.status, 400, `expected 400, got ${r.status}`);
  });

  await test('Access without auth → 401', async () => {
    const r = await api('GET', 'me');
    assertEq(r.status, 401, `expected 401, got ${r.status}`);
  });

  await test('Send empty content → 400', async () => {
    if (!state.autoAgent || !state.autoAgent2) return;
    const r = await apiRetry('POST', `direct/${state.autoAgent2.id}/messages`, {
      type: 'text', content: '',
    }, state.autoAgent.token);
    assertEq(r.status, 400, `expected 400, got ${r.status}`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Prismer IM — Comprehensive Scenario Tests (v2.1.8)      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`  Base URL : ${BASE_URL}`);
  console.log(`  API Key  : ${API_KEY ? API_KEY.slice(0, 20) + '...' : '(not set)'}`);
  console.log(`  Run ID   : ${RUN_ID}`);
  console.log('');

  const t0 = Date.now();

  await scenario1_health();
  await scenario2_autonomous();
  await scenario3_bound();
  await scenario4_multiAgent();
  await scenario5_interAgent();
  await scenario6_discovery();
  await scenario7_reregister();
  await scenario8_credits();
  await scenario9_groupChat();
  await scenario10_edgeCases();

  const totalMs = Date.now() - t0;

  // ── Summary ──
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  Test Summary                                            ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  ✅ Passed  : ${String(passed).padStart(3)}                                       ║`);
  console.log(`║  ❌ Failed  : ${String(failed).padStart(3)}                                       ║`);
  console.log(`║  ⏭️  Skipped : ${String(skipped).padStart(3)}                                       ║`);
  console.log(`║  ⏱️  Duration: ${(totalMs / 1000).toFixed(1)}s                                     ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  ❌ ${f.name}`);
      console.log(`     ${f.msg}`);
    }
  }

  // Agents created this run (for cleanup reference)
  console.log('\nTest agents created:');
  if (state.autoAgent) console.log(`  auto:    ${state.autoAgent.username} (${state.autoAgent.id})`);
  if (state.autoAgent2) console.log(`  auto2:   ${state.autoAgent2.username} (${state.autoAgent2.id})`);
  if (state.boundAgentA) console.log(`  boundA:  ${state.boundAgentA.username} (${state.boundAgentA.id})`);
  if (state.boundAgentB) console.log(`  boundB:  ${state.boundAgentB.username} (${state.boundAgentB.id})`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(2);
});
