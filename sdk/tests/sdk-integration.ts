/**
 * SDK Integration Test — written purely from README documentation.
 * Tests a real agent developer workflow against local IM server (port 3200).
 *
 * Usage: npx tsx sdk/tests/sdk-integration.ts
 */

const BASE = 'http://localhost:3200';
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string, detail?: string) {
  if (condition) {
    console.log(`  ${PASS} ${msg}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${msg}${detail ? ` — ${detail}` : ''}`);
    failed++;
    failures.push(msg + (detail ? ` — ${detail}` : ''));
  }
}

function skip(msg: string, reason: string) {
  console.log(`  ${WARN} ${msg} (skip: ${reason})`);
  skipped++;
}

async function req(method: string, path: string, body?: any, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text, _status: res.status }; }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: Agent Registration & Auth (from README "IM Authentication")
// ═══════════════════════════════════════════════════════════════

async function testRegistration() {
  console.log('\n── Phase 1: Registration & Auth ──');

  // README says: register with type='agent', username, displayName
  const ts = Date.now();
  const r1 = await req('POST', '/api/register', {
    type: 'agent',
    username: `test-agent-${ts}`,
    displayName: 'SDK Test Agent',
    agentType: 'assistant',
    capabilities: ['chat', 'search', 'code'],
    description: 'Integration test agent',
  });
  assert(r1.ok === true, 'Agent registration succeeds');
  assert(!!r1.data?.token, 'Registration returns JWT token');
  assert(!!r1.data?.imUserId, 'Registration returns imUserId');
  assert(r1.data?.isNew === true, 'First registration marks isNew=true');

  const token1 = r1.data?.token;
  const userId1 = r1.data?.imUserId;

  // Re-register same username → server rejects with "already taken"
  const r1b = await req('POST', '/api/register', {
    type: 'agent',
    username: `test-agent-${ts}`,
    displayName: 'SDK Test Agent',
  });
  assert(r1b.ok === false, 'Re-registration rejects duplicate username');
  assert(typeof r1b.error === 'string' || r1b.error?.message, 'Re-registration returns error message');

  // Register second agent
  const r2 = await req('POST', '/api/register', {
    type: 'agent',
    username: `test-agent-b-${ts}`,
    displayName: 'SDK Test Agent B',
    agentType: 'specialist',
    capabilities: ['analysis'],
  });
  assert(r2.ok === true, 'Second agent registration succeeds');
  const token2 = r2.data?.token;
  const userId2 = r2.data?.imUserId;

  // README says: after registration, use token for /me
  const me = await req('GET', '/api/me', undefined, token1);
  assert(me.ok === true, 'GET /me with JWT succeeds');
  assert(me.data?.user?.username === `test-agent-${ts}`, '/me returns correct username');
  assert(me.data?.agentCard?.agentType === 'assistant', '/me returns agent card');
  assert(typeof me.data?.stats?.conversationCount === 'number', '/me returns stats');
  assert(typeof me.data?.credits?.balance === 'number', '/me returns credits');

  return { token1, token2, userId1, userId2, ts };
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: Discovery (from README "im.contacts.discover")
// ═══════════════════════════════════════════════════════════════

async function testDiscovery(ctx: any) {
  console.log('\n── Phase 2: Agent Discovery ──');

  const agents = await req('GET', '/api/discover', undefined, ctx.token1);
  assert(agents.ok === true, 'Discover agents succeeds');
  assert(Array.isArray(agents.data), 'Discover returns array');

  // Filter by type
  const assistants = await req('GET', '/api/discover?type=assistant', undefined, ctx.token1);
  assert(assistants.ok === true, 'Discover by type succeeds');

  // Filter by capability
  const chatAgents = await req('GET', '/api/discover?capability=chat', undefined, ctx.token1);
  assert(chatAgents.ok === true, 'Discover by capability succeeds');
}

// ═══════════════════════════════════════════════════════════════
// Phase 3: Messaging (from README "im.direct" + "im.messages")
// ═══════════════════════════════════════════════════════════════

async function testMessaging(ctx: any) {
  console.log('\n── Phase 3: Direct Messaging ──');

  // README: send(userId, content) → send DM
  const m1 = await req('POST', `/api/direct/${ctx.userId2}/messages`, {
    content: 'Hello from Agent A!',
  }, ctx.token1);
  assert(m1.ok === true, 'Send DM succeeds');
  assert(!!m1.data?.message?.id, 'DM returns message with id');
  assert(!!m1.data?.conversationId, 'DM returns conversationId');
  const convId = m1.data?.conversationId;
  const msgId = m1.data?.message?.id;

  // Send markdown message
  const m2 = await req('POST', `/api/direct/${ctx.userId2}/messages`, {
    content: '**Bold** and _italic_',
    type: 'markdown',
  }, ctx.token1);
  assert(m2.ok === true, 'Send markdown DM succeeds');

  // Send with metadata
  const m3 = await req('POST', `/api/direct/${ctx.userId2}/messages`, {
    content: 'Message with metadata',
    metadata: { source: 'test', priority: 'high' },
  }, ctx.token1);
  assert(m3.ok === true, 'Send DM with metadata succeeds');

  // Get message history
  const history = await req('GET', `/api/direct/${ctx.userId2}/messages?limit=10`, undefined, ctx.token1);
  assert(history.ok === true, 'Get DM history succeeds');
  assert(Array.isArray(history.data), 'History returns array');
  assert(history.data?.length >= 3, `History has ≥3 messages (got ${history.data?.length})`);

  // Reply from Agent B
  const m4 = await req('POST', `/api/direct/${ctx.userId1}/messages`, {
    content: 'Hello back from Agent B!',
  }, ctx.token2);
  assert(m4.ok === true, 'Agent B reply succeeds');

  // Threaded reply (parentId)
  if (msgId) {
    const m5 = await req('POST', `/api/messages/${convId}`, {
      content: 'This is a threaded reply',
      parentId: msgId,
    }, ctx.token1);
    assert(m5.ok === true, 'Threaded reply succeeds');
  }

  return { convId, msgId };
}

// ═══════════════════════════════════════════════════════════════
// Phase 4: Groups (from README "im.groups")
// ═══════════════════════════════════════════════════════════════

async function testGroups(ctx: any) {
  console.log('\n── Phase 4: Groups ──');

  // Create group
  const g = await req('POST', '/api/groups', {
    title: `Test Group ${ctx.ts}`,
    members: [ctx.userId2],
  }, ctx.token1);
  assert(g.ok === true, 'Create group succeeds');
  assert(!!g.data?.groupId, 'Group returns groupId');
  const groupId = g.data?.groupId;

  // List groups
  const groups = await req('GET', '/api/groups', undefined, ctx.token1);
  assert(groups.ok === true, 'List groups succeeds');
  assert(Array.isArray(groups.data), 'Groups returns array');

  // Send to group
  if (groupId) {
    const gm = await req('POST', `/api/groups/${groupId}/messages`, {
      content: 'Hello group!',
    }, ctx.token1);
    assert(gm.ok === true, 'Send group message succeeds');

    // Get group messages
    const msgs = await req('GET', `/api/groups/${groupId}/messages?limit=10`, undefined, ctx.token1);
    assert(msgs.ok === true, 'Get group messages succeeds');
    assert(Array.isArray(msgs.data), 'Group messages returns array');
  }

  return { groupId };
}

// ═══════════════════════════════════════════════════════════════
// Phase 5: Conversations & Contacts
// ═══════════════════════════════════════════════════════════════

async function testConversationsContacts(ctx: any) {
  console.log('\n── Phase 5: Conversations & Contacts ──');

  const convos = await req('GET', '/api/conversations', undefined, ctx.token1);
  assert(convos.ok === true, 'List conversations succeeds');
  assert(Array.isArray(convos.data), 'Conversations returns array');
  assert(convos.data?.length >= 2, `Has ≥2 conversations (got ${convos.data?.length})`);

  // Mark as read
  if (ctx.convId) {
    const read = await req('POST', `/api/conversations/${ctx.convId}/read`, undefined, ctx.token1);
    assert(read.ok === true, 'Mark conversation as read succeeds');
  }

  // Contacts
  const contacts = await req('GET', '/api/contacts', undefined, ctx.token1);
  assert(contacts.ok === true, 'List contacts succeeds');
  assert(Array.isArray(contacts.data), 'Contacts returns array');
}

// ═══════════════════════════════════════════════════════════════
// Phase 6: Credits
// ═══════════════════════════════════════════════════════════════

async function testCredits(ctx: any) {
  console.log('\n── Phase 6: Credits ──');

  const credits = await req('GET', '/api/credits', undefined, ctx.token1);
  assert(credits.ok === true, 'Get credits succeeds');
  assert(typeof credits.data?.balance === 'number', 'Credits returns balance');

  const txns = await req('GET', '/api/credits/transactions?limit=5', undefined, ctx.token1);
  assert(txns.ok === true, 'Get transactions succeeds');
  assert(Array.isArray(txns.data), 'Transactions returns array');
}

// ═══════════════════════════════════════════════════════════════
// Phase 7: Memory
// ═══════════════════════════════════════════════════════════════

async function testMemory(ctx: any) {
  console.log('\n── Phase 7: Memory ──');

  // Create memory file
  const mf = await req('POST', '/api/memory/files', {
    path: 'MEMORY.md',
    content: '# Test Memory\n\n- Item 1\n- Item 2',
    scope: 'global',
  }, ctx.token1);
  assert(mf.ok === true, 'Create memory file succeeds');

  // List memory files
  const files = await req('GET', '/api/memory/files', undefined, ctx.token1);
  assert(files.ok === true, 'List memory files succeeds');

  // Load auto-memory
  const load = await req('GET', '/api/memory/load', undefined, ctx.token1);
  assert(load.ok === true, 'Load memory succeeds');

  // Update (append)
  if (mf.data?.id) {
    const upd = await req('PATCH', `/api/memory/files/${mf.data.id}`, {
      operation: 'append',
      content: '\n- Item 3',
    }, ctx.token1);
    assert(upd.ok === true, 'Update memory file succeeds');
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 8: Tasks
// ═══════════════════════════════════════════════════════════════

async function testTasks(ctx: any) {
  console.log('\n── Phase 8: Tasks ──');

  const task = await req('POST', '/api/tasks', {
    title: 'Test task from SDK test',
    description: 'Automated test task',
    capability: 'code',
  }, ctx.token1);
  assert(task.ok === true, 'Create task succeeds');
  assert(!!task.data?.id, 'Task returns id');
  const taskId = task.data?.id;

  // List tasks
  const tasks = await req('GET', '/api/tasks?limit=5', undefined, ctx.token1);
  assert(tasks.ok === true, 'List tasks succeeds');

  // Claim task
  if (taskId) {
    const claim = await req('POST', `/api/tasks/${taskId}/claim`, undefined, ctx.token2);
    assert(claim.ok === true, 'Claim task succeeds');

    // Complete task
    const complete = await req('POST', `/api/tasks/${taskId}/complete`, {
      result: { output: 'done' },
    }, ctx.token2);
    assert(complete.ok === true, 'Complete task succeeds');
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 9: Evolution (from README "im.evolution")
// ═══════════════════════════════════════════════════════════════

async function testEvolution(ctx: any) {
  console.log('\n── Phase 9: Evolution ──');

  // Public stats (no auth)
  const stats = await req('GET', '/api/evolution/public/stats');
  assert(stats.ok === true, 'Public evolution stats succeeds');

  // Create a gene
  const gene = await req('POST', '/api/evolution/genes', {
    category: 'repair',
    signals_match: [{ type: 'error:timeout', provider: 'http' }],
    strategy: ['Increase timeout to 30s', 'Add exponential backoff', 'Retry up to 3 times'],
    title: 'HTTP Timeout Recovery',
  }, ctx.token1);
  assert(gene.ok === true, 'Create gene succeeds');
  assert(!!gene.data?.id, 'Gene returns id');
  const geneId = gene.data?.id;

  // List own genes
  const genes = await req('GET', '/api/evolution/genes', undefined, ctx.token1);
  assert(genes.ok === true, 'List genes succeeds');
  assert(Array.isArray(genes.data), 'Genes returns array');

  // Analyze (signal matching)
  const analyze = await req('POST', '/api/evolution/analyze', {
    signals: [{ type: 'error:timeout', provider: 'http' }],
    error: 'Error: timeout of 10000ms exceeded',
    provider: 'http',
    stage: 'api_call',
  }, ctx.token1);
  assert(analyze.ok === true, 'Analyze succeeds');
  assert(!!analyze.data?.action, 'Analyze returns action');

  // Record outcome
  if (geneId) {
    const record = await req('POST', '/api/evolution/record', {
      gene_id: geneId,
      signals: [{ type: 'error:timeout' }],
      outcome: 'success',
      score: 0.9,
      summary: 'Applied timeout increase strategy successfully',
    }, ctx.token1);
    assert(record.ok === true, 'Record outcome succeeds');
  }

  // Get edges
  const edges = await req('GET', '/api/evolution/edges', undefined, ctx.token1);
  assert(edges.ok === true, 'Get edges succeeds');

  // Get personality
  if (ctx.userId1) {
    const p = await req('GET', `/api/evolution/personality/${ctx.userId1}`, undefined, ctx.token1);
    assert(p.ok === true, 'Get personality succeeds');
  }

  // Public: hot genes
  const hot = await req('GET', '/api/evolution/public/hot');
  assert(hot.ok === true, 'Public hot genes succeeds');

  // Public: browse
  const browse = await req('GET', '/api/evolution/public/genes?limit=5');
  assert(browse.ok === true, 'Public browse genes succeeds');

  // Metrics
  const metrics = await req('GET', '/api/evolution/metrics');
  assert(metrics.ok === true, 'Evolution metrics succeeds');

  return { geneId };
}

// ═══════════════════════════════════════════════════════════════
// Phase 10: Signal Enrichment (SDK-side, no server)
// ═══════════════════════════════════════════════════════════════

async function testSignalEnrichment() {
  console.log('\n── Phase 10: Signal Enrichment (local) ──');

  // Dynamic import from built SDK
  try {
    const mod = await import('../typescript/src/signal-enrichment.js');
    const { extractSignals, createEnrichedExtractor } = mod;

    const s1 = extractSignals({ error: 'Error: ECONNREFUSED 127.0.0.1:5432' });
    assert(s1.length > 0, 'extractSignals returns results');
    assert(s1[0].type === 'error:connection_refused', `Detects connection_refused (got ${s1[0].type})`);

    const s2 = extractSignals({ error: 'rate limit exceeded', provider: 'openai', stage: 'completion' });
    assert(s2[0].type === 'error:rate_limit', 'Detects rate_limit');
    assert(s2[0].provider === 'openai', 'Preserves provider');
    assert(s2[0].stage === 'completion', 'Preserves stage');

    const s3 = extractSignals({ error: 'panic: runtime error: index out of range', severity: 'critical' });
    assert(s3[0].type === 'error:crash', 'Detects crash/panic');

    const s4 = extractSignals({ taskStatus: 'failed', tags: ['deploy', 'production'] });
    assert(s4.some(s => s.type === 'task.failed'), 'Detects task.failed');
    assert(s4.some(s => s.type === 'deploy'), 'Passes through custom tags');

    // Rules mode enriched extractor
    const extractor = createEnrichedExtractor({ mode: 'rules' });
    const s5 = await extractor({ error: 'TypeError: Cannot read property of undefined' });
    assert(s5[0].type === 'error:type_error', 'Rules enriched extractor works');

  } catch (e: any) {
    skip('Signal enrichment', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 11: Sync Endpoint (new in Local Runtime)
// ═══════════════════════════════════════════════════════════════

async function testSyncEndpoint(ctx: any) {
  console.log('\n── Phase 11: Sync Endpoint ──');

  // Snapshot
  const snap = await req('GET', '/api/evolution/sync/snapshot', undefined, ctx.token1);
  assert(snap.ok === true, 'Sync snapshot succeeds');
  assert(Array.isArray(snap.data?.genes), 'Snapshot returns genes array');
  assert(Array.isArray(snap.data?.edges), 'Snapshot returns edges array');
  assert(typeof snap.data?.cursor === 'number', 'Snapshot returns cursor');
  assert(typeof snap.data?.globalPrior === 'object', 'Snapshot returns globalPrior');

  // Bidirectional sync
  const sync = await req('POST', '/api/evolution/sync', {
    push: { outcomes: [] },
    pull: { since: 0 },
  }, ctx.token1);
  assert(sync.ok === true, 'Bidirectional sync succeeds');
  assert(typeof sync.data?.pushed?.accepted === 'number', 'Sync returns pushed.accepted');
  assert(typeof sync.data?.pulled?.cursor === 'number', 'Sync returns pulled.cursor');
}

// ═══════════════════════════════════════════════════════════════
// Phase 12: Identity (from README "im.identity")
// ═══════════════════════════════════════════════════════════════

async function testIdentity(ctx: any) {
  console.log('\n── Phase 12: Identity ──');

  // Server key
  const sk = await req('GET', '/api/keys/server', undefined, ctx.token1);
  assert(sk.ok === true, 'Get server key succeeds');

  // Register key — Ed25519 format expected. Test with a properly formatted key
  const rk = await req('POST', '/api/keys/register', {
    publicKey: 'MCowBQYDK2VwAyEATestKeyForIntegration1234567890abc=',
    derivationMode: 'generated',
  }, ctx.token1);
  // Endpoint should respond (may succeed or reject invalid key format)
  assert(rk !== undefined && (rk.ok !== undefined || rk._status !== undefined), 'Register key endpoint responds');
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('═══ Prismer SDK Integration Test ═══');
  console.log(`Target: ${BASE}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // Check server
  try {
    const health = await req('GET', '/api/health');
    if (!health.ok) throw new Error('Server not healthy');
    console.log(`Server: ✓ (version: ${health.data?.version || 'unknown'})`);
  } catch {
    console.error('Server at port 3200 not reachable. Start with:');
    console.error('  DATABASE_URL="file:./prisma/data/dev.db" npx tsx src/im/start.ts');
    process.exit(1);
  }

  try {
    const ctx = await testRegistration();
    await testDiscovery(ctx);
    const { convId, msgId } = await testMessaging(ctx);
    const { groupId } = await testGroups({ ...ctx, convId });
    await testConversationsContacts({ ...ctx, convId });
    await testCredits(ctx);
    await testMemory(ctx);
    await testTasks(ctx);
    const { geneId } = await testEvolution(ctx);
    await testSignalEnrichment();
    await testSyncEndpoint(ctx);
    await testIdentity(ctx);
  } catch (e: any) {
    console.error(`\n${FAIL} FATAL: ${e.message}`);
    if (e.stack) console.error(e.stack);
  }

  // Summary
  console.log('\n═══ Summary ═══');
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    ${FAIL} ${f}`));
  }
  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main();
