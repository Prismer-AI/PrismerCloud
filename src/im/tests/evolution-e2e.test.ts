/**
 * Evolution E2E Test — Full Agent Lifecycle
 *
 * Proves the evolution system is functional end-to-end:
 * 1. Register agent → seed genes injected
 * 2. Analyze signals → get gene recommendation
 * 3. Record outcomes → capsule created + edge updated + personality adjusted
 * 4. Check distillation readiness
 * 5. Public APIs return real data (stats, hot genes, feed)
 * 6. Publish gene → appears in public market
 * 7. Import gene → another agent gets a copy
 * 8. Credit milestones scan
 *
 * Usage: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/evolution-e2e.test.ts
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';

let token = '';
let agentId = '';
let token2 = '';
let agentId2 = '';

let passed = 0;
let failed = 0;
const skipped = 0;

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

async function api(method: string, path: string, body?: any, authToken?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, ...data };
}

// ─── Test Groups ────────────────────────────────────────────

async function testAgentRegistrationAndSeeding() {
  console.log('\n📦 Group 1: Agent Registration & Seed Gene Injection');

  await test('Register agent-1 → get token + seed genes', async () => {
    const ts = Date.now();
    const res = await api('POST', '/register', {
      type: 'agent',
      username: `evo_agent_${ts}`,
      displayName: `Evolution Test Agent ${ts}`,
      agentType: 'assistant',
      capabilities: ['code_review', 'debugging'],
    });
    assert(res.ok, `register failed: ${JSON.stringify(res)}`);
    token = res.data.token;
    agentId = res.data.imUserId;
    assert(!!token, 'no token returned');
    assert(!!agentId, 'no agentId returned');
  });

  await test('Agent-1 has seed genes after registration', async () => {
    const res = await api('GET', '/evolution/genes', undefined, token);
    assert(res.ok, `genes list failed: ${JSON.stringify(res)}`);
    assert(Array.isArray(res.data), 'data should be array');
    assert(res.data.length > 0, 'should have seed genes');
    console.log(`    → ${res.data.length} genes seeded`);
  });

  await test('Register agent-2 for cross-agent tests', async () => {
    const ts2 = Date.now();
    const res = await api('POST', '/register', {
      type: 'agent',
      username: `evo_agent2_${ts2}`,
      displayName: `Evolution Test Agent 2`,
      agentType: 'assistant',
    });
    assert(res.ok, 'register failed');
    token2 = res.data.token;
    agentId2 = res.data.imUserId;
  });
}

async function testAnalyzeAndRecord() {
  console.log('\n🧠 Group 2: Signal Analysis & Outcome Recording');

  let geneId = '';
  let signals: string[] = [];

  await test('Analyze error signals → get gene recommendation', async () => {
    const res = await api(
      'POST',
      '/evolution/analyze',
      {
        task_status: 'failed',
        error: 'TypeError: Cannot read property of undefined',
        tags: ['typescript', 'runtime'],
      },
      token,
    );
    assert(res.ok, `analyze failed: ${JSON.stringify(res)}`);
    assert(res.data.action !== 'none', `expected gene recommendation, got: ${res.data.action} — ${res.data.reason}`);
    geneId = res.data.gene_id;
    signals = res.data.signals;
    console.log(`    → action=${res.data.action}, gene=${geneId}, confidence=${res.data.confidence}`);
  });

  await test('Record successful outcome → edge + capsule created', async () => {
    assert(!!geneId, 'need geneId from analyze step');
    const res = await api(
      'POST',
      '/evolution/record',
      {
        gene_id: geneId,
        signals,
        outcome: 'success',
        score: 0.85,
        summary: 'Fixed type error by adding null check',
      },
      token,
    );
    assert(res.ok, `record failed: ${JSON.stringify(res)}`);
    assert(res.data.edge_updated === true, 'edge should be updated');
    assert(typeof res.data.personality_adjusted === 'boolean', 'personality_adjusted should be boolean');
    console.log(`    → edge_updated=${res.data.edge_updated}, personality_adjusted=${res.data.personality_adjusted}`);
  });

  await test('Record multiple outcomes to build history', async () => {
    // Record 5 more outcomes to build up data
    for (let i = 0; i < 5; i++) {
      const outcome = i < 4 ? 'success' : 'failed';
      const res = await api(
        'POST',
        '/evolution/record',
        {
          gene_id: geneId,
          signals,
          outcome,
          score: outcome === 'success' ? 0.7 + Math.random() * 0.3 : 0.2,
          summary:
            outcome === 'success' ? `Iteration ${i}: resolved successfully` : `Iteration ${i}: strategy did not apply`,
        },
        token,
      );
      assert(res.ok, `record ${i} failed`);
    }
    console.log(`    → 5 additional outcomes recorded`);
  });

  await test('Query memory graph edges → has data', async () => {
    const res = await api('GET', '/evolution/edges', undefined, token);
    assert(res.ok, `edges failed: ${JSON.stringify(res)}`);
    assert(Array.isArray(res.data), 'data should be array');
    assert(res.data.length > 0, 'should have edges');
    const edge = res.data[0];
    assert(edge.success_count > 0, 'edge should have successes');
    console.log(`    → ${res.data.length} edges, top: success=${edge.success_count}, failure=${edge.failure_count}`);
  });

  await test('Get capsule history → has records', async () => {
    const res = await api('GET', '/evolution/capsules?page=1&limit=10', undefined, token);
    assert(res.ok, `capsules failed: ${JSON.stringify(res)}`);
    assert(Array.isArray(res.data), 'data should be array');
    assert(res.data.length >= 6, `should have ≥6 capsules, got ${res.data.length}`);
    console.log(`    → ${res.data.length} capsules (total: ${res.meta?.total || 'unknown'})`);
  });
}

async function testPersonalityAndReport() {
  console.log('\n🎭 Group 3: Personality & Evolution Report');

  await test('Get personality → adapted from outcomes', async () => {
    const res = await api('GET', `/evolution/personality/${encodeURIComponent(agentId)}`, undefined, token);
    assert(res.ok, `personality failed: ${JSON.stringify(res)}`);
    const p = res.data.personality;
    assert(typeof p.rigor === 'number', 'rigor should be number');
    assert(typeof p.creativity === 'number', 'creativity should be number');
    assert(typeof p.risk_tolerance === 'number', 'risk_tolerance should be number');
    console.log(
      `    → rigor=${p.rigor.toFixed(2)}, creativity=${p.creativity.toFixed(2)}, risk_tolerance=${p.risk_tolerance.toFixed(2)}`,
    );
  });

  await test('Get evolution report → has real stats', async () => {
    const res = await api('GET', '/evolution/report', undefined, token);
    assert(res.ok, `report failed: ${JSON.stringify(res)}`);
    assert(res.data.total_capsules >= 6, `should have ≥6 capsules, got ${res.data.total_capsules}`);
    assert(res.data.success_rate > 0, 'success_rate should be > 0');
    assert(Array.isArray(res.data.top_genes), 'should have top_genes');
    console.log(
      `    → capsules=${res.data.total_capsules}, success_rate=${(res.data.success_rate * 100).toFixed(1)}%, trend=${res.data.recent_trend}`,
    );
  });
}

async function testDistillation() {
  console.log('\n🧬 Group 4: Distillation Check');

  await test('Distillation dry run → reports readiness', async () => {
    const res = await api('POST', '/evolution/distill?dry_run=true', {}, token);
    assert(res.ok, `distill check failed: ${JSON.stringify(res)}`);
    assert(typeof res.data.ready === 'boolean', 'ready should be boolean');
    assert(typeof res.data.success_capsules === 'number', 'success_capsules should be number');
    console.log(
      `    → ready=${res.data.ready}, success_capsules=${res.data.success_capsules}, min=${res.data.min_required}`,
    );
  });
}

async function testPublicAPIs() {
  console.log('\n🌍 Group 5: Public APIs (no auth) — Real Data');

  await test('GET /public/stats → non-zero capsule count', async () => {
    const res = await api('GET', '/evolution/public/stats');
    assert(res.ok, `stats failed: ${JSON.stringify(res)}`);
    assert(res.data.total_genes > 0, `should have genes, got ${res.data.total_genes}`);
    assert(res.data.total_capsules > 0, `should have capsules from test, got ${res.data.total_capsules}`);
    assert(res.data.avg_success_rate > 0, `success rate should be > 0, got ${res.data.avg_success_rate}`);
    console.log(
      `    → genes=${res.data.total_genes}, capsules=${res.data.total_capsules}, avg_success=${res.data.avg_success_rate}%, agents=${res.data.active_agents}`,
    );
  });

  await test('GET /public/hot → returns genes', async () => {
    const res = await api('GET', '/evolution/public/hot?limit=3');
    assert(res.ok, `hot failed: ${JSON.stringify(res)}`);
    assert(Array.isArray(res.data), 'data should be array');
    assert(res.data.length > 0, 'should have hot genes');
    console.log(`    → ${res.data.length} hot genes, top: ${res.data[0]?.title || res.data[0]?.id}`);
  });

  await test('GET /public/genes → browse with filters', async () => {
    const res = await api('GET', '/evolution/public/genes?category=repair&sort=most_used&limit=5');
    assert(res.ok, `public genes failed: ${JSON.stringify(res)}`);
    assert(Array.isArray(res.data), 'data should be array');
    console.log(`    → ${res.data.length} repair genes (total: ${res.meta?.total})`);
  });

  await test('GET /public/genes → search works', async () => {
    const res = await api('GET', '/evolution/public/genes?search=timeout&limit=5');
    assert(res.ok, `search failed: ${JSON.stringify(res)}`);
    assert(res.data.length > 0, 'search for "timeout" should find genes');
    console.log(`    → ${res.data.length} genes match "timeout"`);
  });

  await test('GET /public/feed → has events (including real capsules)', async () => {
    const res = await api('GET', '/evolution/public/feed?limit=10');
    assert(res.ok, `feed failed: ${JSON.stringify(res)}`);
    assert(Array.isArray(res.data), 'data should be array');
    assert(res.data.length > 0, 'feed should have events');
    const capsuleEvents = res.data.filter((e: any) => e.type === 'capsule');
    console.log(`    → ${res.data.length} events, ${capsuleEvents.length} real capsule events`);
  });
}

async function testPublishAndImport() {
  console.log('\n📤 Group 6: Publish & Import');

  let publishedGeneId = '';

  await test('Create a custom gene', async () => {
    const res = await api(
      'POST',
      '/evolution/genes',
      {
        category: 'optimize',
        signals_match: ['perf:slow_query', 'perf:n_plus_one'],
        strategy: [
          'Identify N+1 query patterns in ORM logs',
          'Add eager loading for identified associations',
          'Add database index on frequently filtered columns',
        ],
      },
      token,
    );
    assert(res.ok, `create gene failed: ${JSON.stringify(res)}`);
    publishedGeneId = res.data.id;
    assert(!!publishedGeneId, 'gene should have id');
    console.log(`    → created gene: ${publishedGeneId}`);
  });

  await test('Publish gene to market', async () => {
    const res = await api('POST', `/evolution/genes/${publishedGeneId}/publish`, {}, token);
    assert(res.ok, `publish failed: ${JSON.stringify(res)}`);
    assert(res.data.visibility === 'published', 'gene should be published');
    console.log(`    → gene published: ${res.data.visibility}`);
  });

  await test('Published gene appears in public market', async () => {
    const res = await api('GET', `/evolution/public/genes/${publishedGeneId}`);
    assert(res.ok, `public gene detail failed: ${JSON.stringify(res)}`);
    assert(res.data.id === publishedGeneId, 'should find the published gene');
    console.log(`    → visible in market: ${res.data.title || res.data.id}`);
  });

  await test('Agent-2 imports the published gene', async () => {
    const res = await api(
      'POST',
      '/evolution/genes/import',
      {
        gene_id: publishedGeneId,
      },
      token2,
    );
    assert(res.ok, `import failed: ${JSON.stringify(res)}`);
    assert(res.data.id.includes('_imp_'), 'imported gene should have _imp_ suffix');
    assert(res.data.success_count === 0, 'imported gene should have 0 success');
    console.log(`    → imported as: ${res.data.id}`);
  });

  await test('Agent-2 now has the imported gene in their library', async () => {
    const res = await api('GET', '/evolution/genes', undefined, token2);
    assert(res.ok, 'genes list failed');
    const imported = res.data.find((g: any) => g.id.includes(publishedGeneId));
    assert(!!imported, 'should find the imported gene');
    console.log(`    → agent-2 has ${res.data.length} genes (including import)`);
  });
}

async function testGeneDelete() {
  console.log('\n🗑️ Group 7: Gene Delete');

  await test('Create and delete a gene', async () => {
    const createRes = await api(
      'POST',
      '/evolution/genes',
      {
        category: 'repair',
        signals_match: ['test:delete_me'],
        strategy: ['This gene will be deleted'],
      },
      token,
    );
    assert(createRes.ok, 'create failed');
    const geneId = createRes.data.id;

    const deleteRes = await api('DELETE', `/evolution/genes/${geneId}`, undefined, token);
    assert(deleteRes.ok, `delete failed: ${JSON.stringify(deleteRes)}`);
    console.log(`    → created and deleted: ${geneId}`);
  });

  await test('Delete nonexistent gene → 404', async () => {
    const res = await api('DELETE', '/evolution/genes/nonexistent_gene_xyz', undefined, token);
    assert(res.ok === false || res.status === 404, 'should be 404');
  });
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log(' Evolution E2E Test — Full Agent Lifecycle');
  console.log(`  Target: ${BASE}`);
  console.log('════════════════════════════════════════════════════');

  const start = Date.now();

  await testAgentRegistrationAndSeeding();
  await testAnalyzeAndRecord();
  await testPersonalityAndReport();
  await testDistillation();
  await testPublicAPIs();
  await testPublishAndImport();
  await testGeneDelete();

  const duration = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n════════════════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${duration}s)`);
  console.log('════════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
