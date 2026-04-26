#!/usr/bin/env node
/**
 * Full-flow integration test — Production (prismer.cloud)
 *
 * Tests:
 * 1. Health check
 * 2. Anonymous agent self-registration (Agent A — simulates Python SDK)
 * 3. API Key agent registration (Agent B — simulates TS SDK)
 * 4. Agent profile (/me)
 * 5. Credits check
 * 6. Agent discovery
 * 7. Agent A sends DM to Agent B
 * 8. Agent B reads DM history
 * 9. Agent B replies
 * 10. Agent A reads DM history
 * 11. Group creation + messaging
 * 12. Conversations list
 * 13. Context API (load URL)
 * 14. Context API (search)
 */

const BASE = 'https://prismer.cloud';
const API_KEY = (process.env.PRISMER_API_KEY || process.env.PRISMER_API_KEY_TEST || '');

let passed = 0;
let failed = 0;
const ts = () => new Date().toISOString().slice(11, 23);

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name} — ${detail || 'FAILED'}`);
    failed++;
  }
}

// ═══════════════════════════════════════════════════
// Test Execution
// ═══════════════════════════════════════════════════

const suffix = Date.now().toString(36).slice(-5);

console.log(`\n🔬 Full-Flow Integration Test (${BASE})`);
console.log(`   Suffix: ${suffix}\n`);

// ── 1. Health ──
console.log('── 1. Health Check ──');
{
  const r = await api('GET', '/api/im/health');
  check('IM health', r.data?.ok === true || r.data?.status === 'ok', JSON.stringify(r.data));
}

// ── 2. Anonymous Agent Registration (Agent A — "Python agent") ──
console.log('\n── 2. Anonymous Agent Registration (Agent A) ──');
let agentA_token, agentA_id;
{
  const r = await api('POST', '/api/im/register', {
    type: 'agent',
    username: `py-agent-${suffix}`,
    displayName: `Python Agent ${suffix}`,
    agentType: 'assistant',
    capabilities: ['chat', 'search', 'code'],
  });
  check('Register ok', r.data?.ok === true, JSON.stringify(r.data));
  check('Got token', !!r.data?.data?.token);
  check('Got imUserId', !!r.data?.data?.imUserId);
  check('Role = agent', r.data?.data?.role === 'agent');
  check('isNew = true', r.data?.data?.isNew === true);

  const id = r.data?.data?.imUserId;
  check('Agent ID length = 11', id?.length === 11, `got ${id?.length}: "${id}"`);
  check('Agent ID alphanumeric', /^[a-z0-9]{11}$/.test(id), `"${id}"`);

  agentA_token = r.data?.data?.token;
  agentA_id = id;
  console.log(`   → Agent A: ${agentA_id} (${r.data?.data?.username})`);
}

// ── 3. API Key Agent Registration (Agent B — "TypeScript agent") ──
console.log('\n── 3. API Key Agent Registration (Agent B) ──');
let agentB_token, agentB_id;
{
  const r = await api('POST', '/api/im/register', {
    type: 'agent',
    username: `ts-agent-${suffix}`,
    displayName: `TypeScript Agent ${suffix}`,
    agentType: 'specialist',
    capabilities: ['code_review', 'refactor'],
  }, API_KEY);
  check('Register ok', r.data?.ok === true, JSON.stringify(r.data));
  check('Got token', !!r.data?.data?.token);
  check('isNew = true', r.data?.data?.isNew === true);

  const id = r.data?.data?.imUserId;
  check('Agent ID length = 11', id?.length === 11, `got ${id?.length}: "${id}"`);

  agentB_token = r.data?.data?.token;
  agentB_id = id;
  console.log(`   → Agent B: ${agentB_id} (${r.data?.data?.username})`);
}

// ── 4. Agent A — /me profile ──
console.log('\n── 4. Agent A Profile (/me) ──');
{
  const r = await api('GET', '/api/im/me', null, agentA_token);
  check('/me ok', r.data?.ok === true, JSON.stringify(r.data));
  const user = r.data?.data?.user;
  check('username matches', user?.username === `py-agent-${suffix}`);
  check('role = agent', user?.role === 'agent');
  check('has stats', !!r.data?.data?.stats);
}

// ── 5. Agent A — Credits ──
console.log('\n── 5. Agent A Credits ──');
{
  const r = await api('GET', '/api/im/credits', null, agentA_token);
  check('Credits ok', r.data?.ok === true, JSON.stringify(r.data));
  const bal = r.data?.data?.balance;
  check('Has balance', typeof bal === 'number', `balance = ${bal}`);
  console.log(`   → Balance: ${bal}`);
}

// ── 6. Agent B — Credits (API Key bound) ──
console.log('\n── 6. Agent B Credits ──');
{
  const r = await api('GET', '/api/im/credits', null, agentB_token);
  check('Credits ok', r.data?.ok === true, JSON.stringify(r.data));
  console.log(`   → Balance: ${r.data?.data?.balance}`);
}

// ── 7. Agent Discovery ──
console.log('\n── 7. Agent Discovery ──');
{
  const r = await api('GET', '/api/im/discover?type=agent&limit=5', null, agentA_token);
  check('Discover ok', r.data?.ok === true, JSON.stringify(r.data));
  const agents = r.data?.data;
  check('Got agents array', Array.isArray(agents), typeof agents);
  if (Array.isArray(agents)) {
    const foundB = agents.some(a => a.id === agentB_id || a.username === `ts-agent-${suffix}`);
    check('Found Agent B', foundB, agents.map(a => a.username).join(', '));
  }
}

// ── 8. Agent A sends DM to Agent B ──
console.log('\n── 8. Agent A → Agent B (DM) ──');
let convId_AB;
{
  const r = await api('POST', `/api/im/direct/${agentB_id}/messages`, {
    content: `Hello from Python Agent! Time: ${ts()}`,
    type: 'text',
  }, agentA_token);
  check('Send ok', r.data?.ok === true, JSON.stringify(r.data));
  convId_AB = r.data?.data?.conversationId;
  check('Got conversationId', !!convId_AB);
  console.log(`   → Conversation: ${convId_AB}`);
}

// ── 9. Agent A sends markdown message ──
console.log('\n── 9. Agent A → Agent B (markdown) ──');
{
  const r = await api('POST', `/api/im/direct/${agentB_id}/messages`, {
    content: `## Status Report\n\n- Task: integration test\n- Status: **running**\n- Time: ${ts()}`,
    type: 'markdown',
  }, agentA_token);
  check('Markdown send ok', r.data?.ok === true, JSON.stringify(r.data));
}

// ── 10. Agent B reads DM history ──
console.log('\n── 10. Agent B reads DM history ──');
{
  const r = await api('GET', `/api/im/direct/${agentA_id}/messages?limit=10`, null, agentB_token);
  check('History ok', r.data?.ok === true, JSON.stringify(r.data));
  const msgs = r.data?.data;
  check('Got messages', Array.isArray(msgs) && msgs.length >= 2, `count: ${msgs?.length}`);
  if (Array.isArray(msgs) && msgs.length > 0) {
    check('Last msg from Agent A', msgs[0]?.senderId === agentA_id);
  }
}

// ── 11. Agent B replies ──
console.log('\n── 11. Agent B → Agent A (reply) ──');
{
  const r = await api('POST', `/api/im/direct/${agentA_id}/messages`, {
    content: `Hello back from TypeScript Agent! I received your message. Time: ${ts()}`,
    type: 'text',
  }, agentB_token);
  check('Reply ok', r.data?.ok === true, JSON.stringify(r.data));
}

// ── 12. Agent A reads reply ──
console.log('\n── 12. Agent A reads reply ──');
{
  const r = await api('GET', `/api/im/direct/${agentB_id}/messages?limit=10`, null, agentA_token);
  check('History ok', r.data?.ok === true, JSON.stringify(r.data));
  const msgs = r.data?.data;
  check('Got 3+ messages', Array.isArray(msgs) && msgs.length >= 3, `count: ${msgs?.length}`);
  const fromB = msgs?.filter(m => m.senderId === agentB_id);
  check('Has reply from Agent B', fromB?.length >= 1);
}

// ── 13. Group creation ──
console.log('\n── 13. Create Group ──');
let groupId;
{
  const r = await api('POST', '/api/im/groups', {
    title: `Test Group ${suffix}`,
    description: 'Integration test group',
    members: [agentA_id, agentB_id],
  }, agentA_token);
  check('Create ok', r.data?.ok === true, JSON.stringify(r.data));
  groupId = r.data?.data?.groupId || r.data?.data?.id || r.data?.data?.conversationId;
  check('Got groupId', !!groupId, JSON.stringify(r.data?.data));
  console.log(`   → Group: ${groupId}`);
}

// ── 14. Group messaging ──
console.log('\n── 14. Group Messaging ──');
if (groupId) {
  const r1 = await api('POST', `/api/im/groups/${groupId}/messages`, {
    content: `@ts-agent-${suffix} Can you review this code?`,
    type: 'text',
  }, agentA_token);
  check('Agent A group msg', r1.data?.ok === true, JSON.stringify(r1.data));

  // Check @mention routing
  const routing = r1.data?.data?.routing || r1.data?.data?.message?.routing;
  if (routing) {
    check('Has routing', !!routing);
    console.log(`   → Routing: ${JSON.stringify(routing)}`);
  }

  const r2 = await api('POST', `/api/im/groups/${groupId}/messages`, {
    content: 'Sure, I will take a look at it now.',
    type: 'text',
  }, agentB_token);
  check('Agent B group msg', r2.data?.ok === true, JSON.stringify(r2.data));

  // Read group history
  const r3 = await api('GET', `/api/im/groups/${groupId}/messages?limit=10`, null, agentA_token);
  check('Group history', r3.data?.ok === true && Array.isArray(r3.data?.data));
  check('2+ group messages', r3.data?.data?.length >= 2, `count: ${r3.data?.data?.length}`);
}

// ── 15. Conversations list ──
console.log('\n── 15. Conversations List ──');
{
  const r = await api('GET', '/api/im/conversations', null, agentA_token);
  check('Conversations ok', r.data?.ok === true, JSON.stringify(r.data));
  const convs = r.data?.data;
  check('Has conversations', Array.isArray(convs) && convs.length >= 2, `count: ${convs?.length}`);
}

// ── 16. Contacts ──
console.log('\n── 16. Contacts ──');
{
  const r = await api('GET', '/api/im/contacts', null, agentA_token);
  check('Contacts ok', r.data?.ok === true, JSON.stringify(r.data));
  const contacts = r.data?.data;
  check('Has contacts', Array.isArray(contacts) && contacts.length >= 1);
}

// ── 17. Agent A re-register (idempotent) — must pass JWT to identify ──
console.log('\n── 17. Re-register (idempotent) ──');
{
  const r = await api('POST', '/api/im/register', {
    type: 'agent',
    username: `py-agent-${suffix}`,
    displayName: `Python Agent ${suffix} (updated)`,
    agentType: 'assistant',
    capabilities: ['chat', 'search', 'code', 'analysis'],
  }, agentA_token);
  check('Re-register ok', r.data?.ok === true, JSON.stringify(r.data));
  check('isNew = false', r.data?.data?.isNew === false);
  check('Same ID', r.data?.data?.imUserId === agentA_id, `got ${r.data?.data?.imUserId}`);
}

// ── 18. Context API — Load URL ──
console.log('\n── 18. Context API — Load URL ──');
{
  const r = await api('POST', '/api/context/load', {
    input: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
    processUncached: true,
  }, API_KEY);
  check('Load ok', r.data?.success === true, JSON.stringify(r.data).slice(0, 300));
  const hqcc = r.data?.result?.hqcc || r.data?.results?.[0]?.hqcc;
  check('Has hqcc', !!hqcc, `cached=${r.data?.result?.cached}, error=${r.data?.result?.error}`);
  if (hqcc) console.log(`   → Mode: ${r.data?.mode}, Cached: ${r.data?.result?.cached}, Length: ${hqcc.length}`);
  else console.log(`   → Mode: ${r.data?.mode}, Cached: ${r.data?.result?.cached}`);
}

// ── 19. Context API — Search ──
console.log('\n── 19. Context API — Search ──');
{
  const r = await api('POST', '/api/context/load', {
    input: 'prismer cloud API',
    search: { topK: 5 },
    return: { topK: 3, format: 'hqcc' },
  }, API_KEY);
  check('Search ok', r.data?.success === true, JSON.stringify(r.data).slice(0, 200));
  check('Has results', Array.isArray(r.data?.results) && r.data.results.length > 0,
    `count: ${r.data?.results?.length}`);
  if (r.data?.results?.length > 0) {
    console.log(`   → ${r.data.results.length} results, first: ${r.data.results[0]?.title?.slice(0, 60)}`);
  }
}

// ── 20. Credits after messaging ──
console.log('\n── 20. Credits After Messaging ──');
{
  const rA = await api('GET', '/api/im/credits', null, agentA_token);
  const rB = await api('GET', '/api/im/credits', null, agentB_token);
  console.log(`   → Agent A balance: ${rA.data?.data?.balance}`);
  console.log(`   → Agent B balance: ${rB.data?.data?.balance}`);
  check('Agent A has balance', typeof rA.data?.data?.balance === 'number');
  check('Agent B has balance', typeof rB.data?.data?.balance === 'number');
}

// ── 21. Credit transactions ──
console.log('\n── 21. Credit Transactions ──');
{
  const r = await api('GET', '/api/im/credits/transactions?limit=5', null, agentA_token);
  check('Transactions ok', r.data?.ok === true, JSON.stringify(r.data));
  const txns = r.data?.data?.transactions || r.data?.data;
  if (Array.isArray(txns)) {
    console.log(`   → ${txns.length} transactions`);
    check('Has transactions', txns.length > 0);
  }
}

// ═══════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}`);

if (failed > 0) {
  console.log('\n⚠️  Some tests failed — review above.\n');
  process.exit(1);
} else {
  console.log('\n🎉 All tests passed!\n');
}
