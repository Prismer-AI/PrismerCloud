/**
 * Prismer IM — Evolution Service Tests
 *
 * Tests Phase S1+S2: signal extraction, gene CRUD, selection, outcome recording,
 * personality adaptation, distillation readiness, and task lifecycle hook.
 *
 * Usage: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/evolution.test.ts
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';
let TOKEN = '';
let USER_ID = '';
let GENE_ID = '';

// ─── Helpers ──────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown) {
  const url = BASE.includes('/api/im') ? `${BASE}${path.replace(/^\/api/, '')}` : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<any>;
}

let total = 0;
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

// ─── Setup ────────────────────────────────────────────────

async function setup() {
  console.log('\n=== Setup: Register test agent ===');

  const username = `evo_test_${Date.now()}`;
  const regResult = await api('POST', '/api/register', {
    username,
    displayName: 'Evolution Test Agent',
    type: 'agent',
  });
  assert(regResult.ok === true, 'Agent registered');
  TOKEN = regResult.data?.token;
  USER_ID = regResult.data?.imUserId;

  // Register agent card (needed for gene storage)
  const agentResult = await api('POST', '/api/agents/register', {
    name: 'Evolution Test Agent',
    description: 'Test agent for evolution',
    capabilities: ['test', 'search'],
    agentType: 'specialist',
  });
  assert(agentResult.ok === true, 'Agent card registered');
}

// ─── Test: Signal Extraction (via /analyze) ───────────────

async function testSignalExtraction() {
  console.log('\n=== Test: Signal Extraction ===');

  // Test with task context
  const r1 = await api('POST', '/api/evolution/analyze', {
    task_status: 'failed',
    task_capability: 'search',
    error: 'Connection timeout',
    tags: ['web', 'retry'],
  });
  assert(r1.ok === true, 'Analyze with context returns ok');
  assert(r1.data?.signals?.length > 0, 'Signals were extracted');
  // Seed genes are auto-cloned on agent registration, so action may be apply_gene/explore
  assert(
    r1.data?.action === 'none' || r1.data?.action === 'apply_gene' || r1.data?.action === 'explore',
    'Seed genes may match → action is none/apply_gene/explore',
  );

  // Test with direct signals
  const r2 = await api('POST', '/api/evolution/analyze', {
    signals: ['task.failed', 'error:timeout', 'capability:search'],
  });
  assert(r2.ok === true, 'Analyze with direct signals works');

  // Test with empty context
  const r3 = await api('POST', '/api/evolution/analyze', {});
  assert(r3.ok === false, 'Empty context returns error');
}

// ─── Test: Gene CRUD ──────────────────────────────────────

async function testGeneCRUD() {
  console.log('\n=== Test: Gene CRUD ===');

  // Create gene
  const createResult = await api('POST', '/api/evolution/genes', {
    category: 'repair',
    signals_match: ['error:timeout', 'capability:search'],
    strategy: ['Step 1: Increase timeout to 30s', 'Step 2: Add retry with exponential backoff'],
    preconditions: ['network available'],
    constraints: { max_credits: 50, max_retries: 5 },
  });
  assert(createResult.ok === true, 'Gene created');
  GENE_ID = createResult.data?.id;
  assert(typeof GENE_ID === 'string', 'Gene has ID');
  assert(createResult.data?.category === 'repair', 'Gene category is repair');

  // List genes
  const listResult = await api('GET', '/api/evolution/genes');
  assert(listResult.ok === true, 'Gene list returns ok');
  assert(listResult.data?.length >= 1, 'At least one gene listed');

  // List with signal filter
  const filteredResult = await api('GET', '/api/evolution/genes?signals=error:timeout');
  assert(filteredResult.ok === true, 'Filtered gene list returns ok');
  assert(filteredResult.data?.length >= 1, 'Filtered list has matching gene');

  // Create a second gene for selection testing
  const createResult2 = await api('POST', '/api/evolution/genes', {
    category: 'optimize',
    signals_match: ['task.completed', 'capability:search'],
    strategy: ['Step 1: Cache results', 'Step 2: Reduce payload size'],
  });
  assert(createResult2.ok === true, 'Second gene created');
}

// ─── Test: Gene Selection (via /analyze) ──────────────────

async function testGeneSelection() {
  console.log('\n=== Test: Gene Selection ===');

  // Now we have genes — analyze should recommend one
  const r1 = await api('POST', '/api/evolution/analyze', {
    signals: ['error:timeout', 'capability:search'],
  });
  assert(r1.ok === true, 'Analyze returns ok');
  assert(r1.data?.action !== 'none', 'Gene selected (action != none)');
  assert(r1.data?.gene_id != null, 'Gene ID returned');
  assert(r1.data?.confidence !== undefined, 'Confidence returned');
}

// ─── Test: Outcome Recording ──────────────────────────────

async function testOutcomeRecording() {
  console.log('\n=== Test: Outcome Recording ===');

  // Record success
  const r1 = await api('POST', '/api/evolution/record', {
    gene_id: GENE_ID,
    signals: ['error:timeout', 'capability:search'],
    outcome: 'success',
    score: 0.85,
    summary: 'Increased timeout fixed the issue',
  });
  assert(r1.ok === true, 'Success outcome recorded');
  assert(r1.data?.edge_updated === true, 'Edge updated');
  assert(r1.data?.personality_adjusted === true, 'Personality adjusted');

  // Record failure
  const r2 = await api('POST', '/api/evolution/record', {
    gene_id: GENE_ID,
    signals: ['error:timeout', 'capability:search'],
    outcome: 'failed',
    score: 0.2,
    summary: 'Timeout still occurred after retry',
  });
  assert(r2.ok === true, 'Failure outcome recorded');

  // Validation: bad outcome value
  const r3 = await api('POST', '/api/evolution/record', {
    gene_id: GENE_ID,
    signals: ['error:timeout'],
    outcome: 'partial',
    summary: 'test',
  });
  assert(r3.ok === false, 'Invalid outcome rejected');

  // Validation: missing fields
  const r4 = await api('POST', '/api/evolution/record', {
    gene_id: GENE_ID,
    outcome: 'success',
  });
  assert(r4.ok === false, 'Missing fields rejected');
}

// ─── Test: Memory Graph ───────────────────────────────────

async function testMemoryGraph() {
  console.log('\n=== Test: Memory Graph ===');

  const r1 = await api('GET', '/api/evolution/edges');
  assert(r1.ok === true, 'Edges query returns ok');
  assert(r1.data?.length >= 1, 'At least one edge exists');

  const edge = r1.data?.[0];
  assert(edge?.gene_id != null, 'Edge has gene_id');
  assert(edge?.success_count >= 0, 'Edge has success_count');
  assert(edge?.confidence > 0, 'Edge has positive confidence');
}

// ─── Test: Personality ────────────────────────────────────

async function testPersonality() {
  console.log('\n=== Test: Personality ===');

  const r1 = await api('GET', `/api/evolution/personality/${USER_ID}`);
  assert(r1.ok === true, 'Personality query returns ok');
  assert(r1.data?.personality?.rigor > 0, 'Rigor is positive');
  assert(r1.data?.personality?.creativity > 0, 'Creativity is positive');
  assert(r1.data?.personality?.risk_tolerance >= 0, 'Risk tolerance is non-negative');
}

// ─── Test: Evolution Report ───────────────────────────────

async function testReport() {
  console.log('\n=== Test: Evolution Report ===');

  const r1 = await api('GET', '/api/evolution/report');
  assert(r1.ok === true, 'Report returns ok');
  assert(r1.data?.agent_id === USER_ID, 'Report is for correct agent');
  assert(r1.data?.total_capsules >= 2, 'Report has capsule count');
  assert(typeof r1.data?.success_rate === 'number', 'Report has success rate');
  assert(r1.data?.personality != null, 'Report includes personality');
}

// ─── Test: Distillation Readiness ─────────────────────────

async function testDistillation() {
  console.log('\n=== Test: Distillation ===');

  // Dry run (we don't have enough capsules yet)
  const r1 = await api('POST', '/api/evolution/distill?dry_run=true');
  assert(r1.ok === true, 'Distill dry run returns ok');
  assert(r1.data?.ready === false, 'Not ready with < 10 capsules');
  assert(r1.data?.min_required === 10, 'Min required is 10');

  // Regular call (should also not distill — not enough data)
  const r2 = await api('POST', '/api/evolution/distill');
  assert(r2.ok === true, 'Distill call returns ok');
  assert(r2.data?.ready === false, 'Still not ready');
}

// ─── Test: Gene Deletion ─────────────────────────────────

async function testGeneDeletion() {
  console.log('\n=== Test: Gene Deletion ===');

  // Delete existing gene
  const r1 = await api('DELETE', `/api/evolution/genes/${GENE_ID}`);
  assert(r1.ok === true, 'Gene deleted');

  // Try to delete again
  const r2 = await api('DELETE', `/api/evolution/genes/${GENE_ID}`);
  assert(r2.ok === false, 'Double-delete returns error');

  // Non-existent gene
  const r3 = await api('DELETE', '/api/evolution/genes/nonexistent');
  assert(r3.ok === false, 'Non-existent gene returns error');
}

// ─── Run ──────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  Prismer IM — Evolution Service Tests  ');
  console.log(`  Base URL: ${BASE}`);
  console.log('========================================');

  try {
    await setup();
    await testSignalExtraction();
    await testGeneCRUD();
    await testGeneSelection();
    await testOutcomeRecording();
    await testMemoryGraph();
    await testPersonality();
    await testReport();
    await testDistillation();
    await testGeneDeletion();
  } catch (err) {
    console.error('\n💥 Fatal error:', err);
    failed++;
  }

  console.log('\n========================================');
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
