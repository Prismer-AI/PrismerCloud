/**
 * EvoMap.ai — Real API Benchmark
 *
 * Tests EvoMap's actual API performance for direct comparison with Prismer.
 * Measures: cold start, gene fetch, publish latency, search accuracy, cross-agent transfer.
 *
 * Usage: npx tsx scripts/benchmark-evomap.ts
 * Output: docs/benchmark/results-evomap.json
 */

const EVOMAP_BASE = 'https://evomap.ai';

interface EvoResult {
  test: string;
  status: number;
  latency: number;
  data?: any;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nodeId = '';
let nodeSecret = '';
let nodeId2 = '';
let nodeSecret2 = '';

async function evoApi(
  path: string,
  messageType: string,
  payload: any,
  secret?: string,
): Promise<{ status: number; data: any; latency: number }> {
  const start = Date.now();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['Authorization'] = `Bearer ${secret}`;

  const body = {
    protocol: 'gep-a2a',
    protocol_version: '1.0.0',
    message_type: messageType,
    message_id: `bench_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sender_id: secret === nodeSecret2 ? nodeId2 : nodeId || undefined,
    timestamp: new Date().toISOString(),
    payload,
  };

  // Retry on 503 up to 3 times
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${EVOMAP_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 503) {
      const wait = (data as any)?.retry_after_ms || 3000;
      console.log(`    503, retry in ${wait}ms (attempt ${attempt + 1}/4)...`);
      await sleep(wait + 500);
      continue;
    }
    return { status: res.status, data, latency: Date.now() - start };
  }
  return { status: 503, data: { error: 'max retries' }, latency: Date.now() - start };
}

async function evoGet(path: string, secret?: string): Promise<{ status: number; data: any; latency: number }> {
  const start = Date.now();
  const headers: Record<string, string> = {};
  if (secret) headers['Authorization'] = `Bearer ${secret}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${EVOMAP_BASE}${path}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 503) {
      await sleep(3000);
      continue;
    }
    return { status: res.status, data, latency: Date.now() - start };
  }
  return { status: 503, data: {}, latency: Date.now() - start };
}

// ─── Tests ──────────────────────────────────────────────────────

async function testRegister(): Promise<EvoResult> {
  console.log('\n━━━ T1: Node Registration (hello) ━━━');
  const r = await evoApi('/a2a/hello', 'hello', {
    capabilities: { evolution: true, repair: true, optimize: true },
    model: 'claude-opus-4-6',
    env_fingerprint: { platform: 'darwin', arch: 'arm64' },
  });

  const p = r.data?.payload || {};
  nodeId = p.your_node_id || '';
  nodeSecret = p.node_secret || '';

  console.log(`  node_id: ${nodeId}`);
  console.log(`  credit_balance: ${p.credit_balance}`);
  console.log(`  heartbeat_interval: ${p.heartbeat_interval_ms}ms`);
  console.log(`  latency: ${r.latency}ms`);

  return {
    test: 'register',
    status: r.status,
    latency: r.latency,
    data: { nodeId, credits: p.credit_balance, heartbeat_ms: p.heartbeat_interval_ms },
  };
}

async function testRegister2(): Promise<EvoResult> {
  console.log('\n━━━ T1b: Register Agent B ━━━');
  const r = await evoApi('/a2a/hello', 'hello', {
    capabilities: { evolution: true },
    model: 'gpt-4o',
    env_fingerprint: { platform: 'linux', arch: 'x86_64' },
  });
  const p = r.data?.payload || {};
  nodeId2 = p.your_node_id || '';
  nodeSecret2 = p.node_secret || '';
  console.log(`  node_id B: ${nodeId2}, latency: ${r.latency}ms`);
  return { test: 'register_b', status: r.status, latency: r.latency };
}

async function testColdStartFetch(): Promise<EvoResult> {
  console.log('\n━━━ T2: Cold Start — Fetch Genes (zero history) ━━━');
  const r = await evoApi(
    '/a2a/fetch',
    'fetch',
    {
      asset_type: 'Gene',
      include_tasks: true,
    },
    nodeSecret,
  );

  const p = r.data?.payload || {};
  const assets = p.assets || [];
  const tasks = p.tasks || [];
  console.log(`  assets: ${assets.length}, tasks: ${tasks.length}`);
  console.log(`  latency: ${r.latency}ms`);
  if (assets.length > 0) {
    assets.slice(0, 3).forEach((a: any) => {
      console.log(
        `    Gene: ${(a.asset_id || '').slice(0, 25)}... cat=${a.category} signals=${JSON.stringify(a.signals_match || []).slice(0, 60)}`,
      );
    });
  }

  return {
    test: 'cold_start_fetch',
    status: r.status,
    latency: r.latency,
    data: { gene_count: assets.length, task_count: tasks.length },
  };
}

async function testSignalSearch(): Promise<EvoResult> {
  console.log('\n━━━ T3: Signal Search — error:timeout ━━━');
  const r = await evoGet(`/a2a/assets/search?q=timeout&type=Gene&limit=5`, nodeSecret);

  const assets = r.data?.payload?.assets || r.data?.assets || r.data?.results || [];
  console.log(`  results: ${Array.isArray(assets) ? assets.length : 'N/A'}`);
  console.log(`  latency: ${r.latency}ms`);
  if (Array.isArray(assets) && assets.length > 0) {
    assets.slice(0, 3).forEach((a: any) => {
      console.log(
        `    ${(a.asset_id || a.id || '').slice(0, 25)}... cat=${a.category} signals=${JSON.stringify(a.signals_match || []).slice(0, 60)}`,
      );
    });
  }

  return {
    test: 'signal_search_timeout',
    status: r.status,
    latency: r.latency,
    data: { results: Array.isArray(assets) ? assets.length : 0 },
  };
}

async function testSemanticSearch(): Promise<EvoResult> {
  console.log('\n━━━ T4: Semantic Search — "rate limit retry" ━━━');
  const r = await evoGet(`/a2a/assets/semantic-search?q=rate+limit+retry+backoff&limit=5`, nodeSecret);

  const assets = r.data?.payload?.results || r.data?.results || [];
  console.log(`  results: ${Array.isArray(assets) ? assets.length : 'N/A'}`);
  console.log(`  latency: ${r.latency}ms`);

  return {
    test: 'semantic_search',
    status: r.status,
    latency: r.latency,
    data: { results: Array.isArray(assets) ? assets.length : 0 },
  };
}

async function testPublishAndTransfer(): Promise<EvoResult[]> {
  console.log('\n━━━ T5: Publish Gene + Cross-Agent Transfer ━━━');
  const results: EvoResult[] = [];

  // Create unique gene
  const geneSignal = `bench:prismer_test_${Date.now()}`;
  const geneObj = {
    type: 'Gene',
    schema_version: '1.0.0',
    category: 'repair',
    signals_match: [geneSignal],
    summary: 'Benchmark test gene for Prismer vs EvoMap comparison - handles custom test signal with retry logic',
    validation: [],
  };
  // Compute asset_id (simplified - just use a hash-like string)
  const geneStr = JSON.stringify(geneObj, Object.keys(geneObj).sort());
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(geneStr));
  const geneAssetId =
    'sha256:' +
    Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const gene = { ...geneObj, asset_id: geneAssetId };

  const capsuleObj = {
    type: 'Capsule',
    schema_version: '1.0.0',
    trigger: [geneSignal],
    gene: geneAssetId,
    summary: 'Benchmark capsule testing cross-agent transfer latency between Prismer and EvoMap evolution engines',
    confidence: 0.9,
    blast_radius: { files: 1, lines: 10 },
    outcome: { status: 'success', score: 0.85 },
    env_fingerprint: { platform: 'darwin', arch: 'arm64' },
  };
  const capsuleStr = JSON.stringify(capsuleObj, Object.keys(capsuleObj).sort());
  const capsuleBuf = await crypto.subtle.digest('SHA-256', encoder.encode(capsuleStr));
  const capsuleAssetId =
    'sha256:' +
    Array.from(new Uint8Array(capsuleBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const capsule = { ...capsuleObj, asset_id: capsuleAssetId };

  const evoEvent = {
    type: 'EvolutionEvent',
    intent: 'repair',
    capsule_id: capsuleAssetId,
    genes_used: [geneAssetId],
    outcome: { status: 'success', score: 0.85 },
    mutations_tried: 1,
    total_cycles: 1,
  };
  const evtStr = JSON.stringify(evoEvent, Object.keys(evoEvent).sort());
  const evtBuf = await crypto.subtle.digest('SHA-256', encoder.encode(evtStr));
  const evtAssetId =
    'sha256:' +
    Array.from(new Uint8Array(evtBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  // Step 1: Publish
  console.log('  Step 1: Publish Gene+Capsule+Event bundle...');
  const publishR = await evoApi(
    '/a2a/publish',
    'publish',
    {
      assets: [gene, capsule, { ...evoEvent, asset_id: evtAssetId }],
    },
    nodeSecret,
  );
  const publishTime = Date.now();

  console.log(`  publish status: ${publishR.status}, latency: ${publishR.latency}ms`);
  if (publishR.status !== 200) {
    console.log(`  publish error: ${JSON.stringify(publishR.data).slice(0, 200)}`);
  }
  results.push({
    test: 'publish_bundle',
    status: publishR.status,
    latency: publishR.latency,
    data: publishR.data?.payload,
  });

  // Step 2: Agent B tries to fetch the same signal
  console.log('  Step 2: Agent B fetches with same signal...');
  await sleep(2000); // Wait a bit for propagation
  const fetchR = await evoApi(
    '/a2a/fetch',
    'fetch',
    {
      asset_type: 'Gene',
    },
    nodeSecret2,
  );
  const transferLatency = Date.now() - publishTime;

  const fetchAssets = fetchR.data?.payload?.assets || [];
  const found = fetchAssets.some((a: any) => a.asset_id === geneAssetId);
  console.log(`  Agent B fetch: ${fetchAssets.length} assets, found our gene: ${found}`);
  console.log(`  transfer latency: ${transferLatency}ms`);

  results.push({
    test: 'cross_agent_transfer',
    status: fetchR.status,
    latency: transferLatency,
    data: { total_assets: fetchAssets.length, gene_found: found, gene_signal: geneSignal },
  });

  return results;
}

async function testMarketplaceStats(): Promise<EvoResult> {
  console.log('\n━━━ T6: Marketplace Stats ━━━');
  const r = await evoGet('/a2a/stats', nodeSecret);
  console.log(`  latency: ${r.latency}ms`);
  const stats = r.data?.payload || r.data || {};
  console.log(`  stats: ${JSON.stringify(stats).slice(0, 200)}`);
  return { test: 'marketplace_stats', status: r.status, latency: r.latency, data: stats };
}

async function testAssetRanked(): Promise<EvoResult> {
  console.log('\n━━━ T7: Ranked Assets (GDI) ━━━');
  const r = await evoGet('/a2a/assets/ranked?limit=5', nodeSecret);
  const assets = r.data?.payload?.assets || r.data?.assets || [];
  console.log(`  ranked assets: ${Array.isArray(assets) ? assets.length : 'N/A'}`);
  console.log(`  latency: ${r.latency}ms`);
  if (Array.isArray(assets)) {
    assets.slice(0, 3).forEach((a: any) => {
      console.log(`    ${(a.asset_id || '').slice(0, 30)}... score=${a.gdi_score || a.score || 'N/A'}`);
    });
  }
  return {
    test: 'ranked_assets',
    status: r.status,
    latency: r.latency,
    data: { count: Array.isArray(assets) ? assets.length : 0 },
  };
}

async function testTaskList(): Promise<EvoResult> {
  console.log('\n━━━ T8: Available Tasks (Bounty) ━━━');
  const r = await evoGet('/task/list', nodeSecret);
  const tasks = r.data?.payload?.tasks || r.data?.tasks || [];
  console.log(`  available tasks: ${Array.isArray(tasks) ? tasks.length : 'N/A'}`);
  console.log(`  latency: ${r.latency}ms`);
  return {
    test: 'task_list',
    status: r.status,
    latency: r.latency,
    data: { count: Array.isArray(tasks) ? tasks.length : 0 },
  };
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  EvoMap.ai — Real API Benchmark                 ║');
  console.log('║  Date: ' + new Date().toISOString().slice(0, 19).padEnd(41) + '║');
  console.log('╚══════════════════════════════════════════════════╝');

  const results: EvoResult[] = [];

  results.push(await testRegister());
  await sleep(2000);
  results.push(await testRegister2());
  await sleep(2000);
  results.push(await testColdStartFetch());
  await sleep(2000);
  results.push(await testSignalSearch());
  await sleep(2000);
  results.push(await testSemanticSearch());
  await sleep(2000);
  const transferResults = await testPublishAndTransfer();
  results.push(...transferResults);
  await sleep(2000);
  results.push(await testMarketplaceStats());
  await sleep(2000);
  results.push(await testAssetRanked());
  await sleep(2000);
  results.push(await testTaskList());

  // Summary
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║                    SUMMARY                       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  for (const r of results) {
    const icon = r.status === 200 ? '✅' : '❌';
    console.log(`║ ${icon} ${r.test.padEnd(25)} ${r.status} ${r.latency}ms`.padEnd(51) + '║');
  }
  console.log('╚══════════════════════════════════════════════════╝');

  // Save
  const fs = await import('fs');
  const path = await import('path');
  const output = {
    target: EVOMAP_BASE,
    timestamp: new Date().toISOString(),
    node_id: nodeId,
    results,
  };
  const outPath = path.join(process.cwd(), 'docs/benchmark/results-evomap.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n结果已保存: ${outPath}`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
