/**
 * Evolution Hypergraph — Performance Benchmark
 *
 * 对比 standard vs hypergraph mode 的延迟和指标表现。
 * 不 mock 数据，使用真实 IM server。
 *
 * 运行:
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx scripts/bench-evolution-hypergraph.ts
 *
 * 前置:
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200/api';
const AGENTS_PER_MODE = 5;
const ROUNDS_PER_AGENT = 20;

interface BenchResult {
  mode: string;
  recordLatencies: number[];
  analyzeLatencies: number[];
  successCount: number;
  totalCount: number;
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

function stats(values: number[]) {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p90: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / n),
    p50: sorted[Math.floor(n * 0.5)],
    p90: sorted[Math.floor(n * 0.9)],
    n,
  };
}

async function benchMode(mode: 'standard' | 'hypergraph'): Promise<BenchResult> {
  const recordLatencies: number[] = [];
  const analyzeLatencies: number[] = [];
  let successCount = 0;
  let totalCount = 0;

  // Register agents
  const agents: Array<{ token: string; id: string }> = [];
  for (let i = 0; i < AGENTS_PER_MODE; i++) {
    const reg = await api('POST', '/register', {
      username: `bench_${mode}_${Date.now()}_${i}`,
      type: 'agent',
      metadata: { evolution_mode: mode },
    });
    if (reg.ok) agents.push({ token: reg.data.token, id: reg.data.user.id });
  }

  if (agents.length === 0) {
    console.log(`  ⚠ No agents registered for ${mode}`);
    return { mode, recordLatencies, analyzeLatencies, successCount, totalCount };
  }

  // Create a test gene
  const geneRes = await api('POST', '/evolution/genes', {
    category: 'repair',
    title: `Bench ${mode} Gene`,
    signals_match: [{ type: 'error:timeout', provider: 'test' }],
    strategy: ['Retry', 'Backoff'],
  }, agents[0].token);
  const geneId = geneRes.ok ? geneRes.data.id : null;

  if (!geneId) {
    console.log(`  ⚠ Gene creation failed for ${mode}`);
    return { mode, recordLatencies, analyzeLatencies, successCount, totalCount };
  }

  // Run analyze → record cycles
  const signals = [
    [{ type: 'error:timeout', provider: 'test' }],
    [{ type: 'error:timeout' }],
    [{ type: 'error:500', provider: 'test', stage: 'api_call' }],
  ];

  for (const agent of agents) {
    for (let r = 0; r < ROUNDS_PER_AGENT; r++) {
      const signal = signals[r % signals.length];
      const outcome = Math.random() < 0.7 ? 'success' : 'failed';

      // Analyze
      const t0 = performance.now();
      await api('POST', '/evolution/analyze', { signals: signal }, agent.token);
      analyzeLatencies.push(Math.round(performance.now() - t0));

      // Record
      const t1 = performance.now();
      const recRes = await api('POST', '/evolution/record', {
        gene_id: geneId,
        outcome,
        signals: signal,
        score: outcome === 'success' ? 0.8 : 0.2,
        summary: `bench ${mode} r${r}`,
      }, agent.token);
      recordLatencies.push(Math.round(performance.now() - t1));

      if (recRes.ok) totalCount++;
      if (outcome === 'success') successCount++;
    }
  }

  return { mode, recordLatencies, analyzeLatencies, successCount, totalCount };
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║   Evolution Hypergraph — Performance Benchmark      ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  Target: ${BASE}`);
  console.log(`  Agents/mode: ${AGENTS_PER_MODE}, Rounds/agent: ${ROUNDS_PER_AGENT}`);
  console.log(`  Total requests/mode: ${AGENTS_PER_MODE * ROUNDS_PER_AGENT * 2}`);

  console.log('\n── Standard Mode ──');
  const t0 = performance.now();
  const stdResult = await benchMode('standard');
  const stdTime = Math.round(performance.now() - t0);
  console.log(`  Done in ${stdTime}ms`);

  console.log('\n── Hypergraph Mode ──');
  const t1 = performance.now();
  const hgResult = await benchMode('hypergraph');
  const hgTime = Math.round(performance.now() - t1);
  console.log(`  Done in ${hgTime}ms`);

  // Collect metrics for comparison
  console.log('\n── Collecting Metrics ──');
  const firstToken = stdResult.recordLatencies.length > 0 ? undefined : undefined;
  // Use any existing agent or skip
  await api('POST', '/evolution/metrics/collect', { window_hours: 1 });

  const metricsRes = await api('GET', '/evolution/metrics');
  if (metricsRes.ok) {
    console.log(`  Verdict: ${metricsRes.data.verdict}`);
  }

  // Summary
  console.log('\n════════════════════════════════════════════════════');
  console.log('  RESULTS COMPARISON');
  console.log('════════════════════════════════════════════════════');

  const stdRec = stats(stdResult.recordLatencies);
  const hgRec = stats(hgResult.recordLatencies);
  const stdAna = stats(stdResult.analyzeLatencies);
  const hgAna = stats(hgResult.analyzeLatencies);

  console.log('\n  recordOutcome() latency (ms):');
  console.log(`    Standard:   mean=${stdRec.mean} p50=${stdRec.p50} p90=${stdRec.p90} (n=${stdRec.n})`);
  console.log(`    Hypergraph: mean=${hgRec.mean} p50=${hgRec.p50} p90=${hgRec.p90} (n=${hgRec.n})`);
  if (stdRec.mean > 0 && hgRec.mean > 0) {
    const overhead = ((hgRec.mean - stdRec.mean) / stdRec.mean * 100).toFixed(1);
    console.log(`    Overhead:   ${overhead}%`);
  }

  console.log('\n  selectGene() latency (ms):');
  console.log(`    Standard:   mean=${stdAna.mean} p50=${stdAna.p50} p90=${stdAna.p90} (n=${stdAna.n})`);
  console.log(`    Hypergraph: mean=${hgAna.mean} p50=${hgAna.p50} p90=${hgAna.p90} (n=${hgAna.n})`);

  console.log('\n  Success Rate:');
  const stdSSR = stdResult.totalCount > 0 ? (stdResult.successCount / stdResult.totalCount * 100).toFixed(1) : 'N/A';
  const hgSSR = hgResult.totalCount > 0 ? (hgResult.successCount / hgResult.totalCount * 100).toFixed(1) : 'N/A';
  console.log(`    Standard:   ${stdSSR}% (${stdResult.successCount}/${stdResult.totalCount})`);
  console.log(`    Hypergraph: ${hgSSR}% (${hgResult.successCount}/${hgResult.totalCount})`);

  console.log('\n  Wall Time:');
  console.log(`    Standard:   ${stdTime}ms`);
  console.log(`    Hypergraph: ${hgTime}ms`);

  if (metricsRes.ok && metricsRes.data) {
    console.log('\n  North Star Metrics (from DB):');
    const { standard: s, hypergraph: h } = metricsRes.data;
    if (s) console.log(`    Standard:   SSR=${s.ssr?.toFixed(3)} GD=${s.gd?.toFixed(3)} ER=${s.er?.toFixed(3)} capsules=${s.totalCapsules}`);
    if (h) console.log(`    Hypergraph: SSR=${h.ssr?.toFixed(3)} GD=${h.gd?.toFixed(3)} ER=${h.er?.toFixed(3)} capsules=${h.totalCapsules}`);
    console.log(`    Verdict:    ${metricsRes.data.verdict}`);
  }

  console.log('\n════════════════════════════════════════════════════\n');
}

main().catch(console.error);
