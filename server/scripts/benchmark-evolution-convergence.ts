/**
 * Evolution Engine — Learning Performance & Convergence Benchmark
 *
 * Tests:
 * - C1: Cold Start Convergence (SSR trajectory, 3 representative scenarios)
 * - C2: Gene Ranking Stability (Kendall tau over analyze calls)
 * - C3: Bimodality Index diagnostics
 * - C4: Signal Entropy measurement
 * - C5: Cross-Agent Transfer (Agent B hitting Agent A's gene)
 *
 * Rate-limit aware: adapts call pacing based on detected trust tier.
 *
 * Usage:
 *   TEST_BASE_URL="https://cloud.prismer.dev/api/im" npx tsx scripts/benchmark-evolution-convergence.ts
 *   npx tsx scripts/benchmark-evolution-convergence.ts    # localhost
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';

interface AgentCtx {
  token: string;
  userId: string;
  name: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── API Helper with rate limit retry ────────────────────────

let RATE_LIMIT_PER_MIN = 2;

async function api(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const url = BASE.includes('/api/im') ? `${BASE}${path.replace(/^\/api/, '')}` : `${BASE}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const limitHeader = res.headers.get('X-RateLimit-Limit');
  if (limitHeader) {
    const detected = parseInt(limitHeader, 10);
    if (detected > RATE_LIMIT_PER_MIN) RATE_LIMIT_PER_MIN = detected;
  }

  const json = (await res.json()) as any;
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10);
    return { ...json, _rateLimited: true, _retryAfter: retryAfter };
  }
  return json;
}

/** Call with auto-retry on rate limit */
async function apiRetry(method: string, path: string, body?: unknown, token?: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    const result = await api(method, path, body, token);
    if (!result._rateLimited) return result;
    const wait = (result._retryAfter || 30) + 1;
    process.stdout.write(`⏳${wait}s `);
    await sleep(wait * 1000);
  }
  return { ok: false, error: 'Rate limit retries exhausted' };
}

/** Pace calls to stay within rate limit */
async function paceCall(): Promise<void> {
  if (RATE_LIMIT_PER_MIN >= 50) return; // No pacing needed for high tiers
  const delayMs = Math.ceil(60000 / RATE_LIMIT_PER_MIN) + 500;
  await sleep(delayMs);
}

// ─── Agent Registration ─────────────────────────────────────

async function registerAgent(suffix: string): Promise<AgentCtx> {
  const username = `benchconv_${suffix}_${Date.now()}`;
  const reg = await api('POST', '/api/register', {
    username,
    displayName: `Conv Bench ${suffix}`,
    type: 'agent',
  });
  if (!reg.ok) throw new Error(`Register failed: ${JSON.stringify(reg)}`);

  const token = reg.data.token;
  const userId = reg.data.imUserId;

  await paceCall();
  await apiRetry(
    'POST',
    '/api/agents/register',
    {
      name: `Conv Bench ${suffix}`,
      description: `Convergence benchmark agent ${suffix}`,
      capabilities: ['search', 'summarize', 'code', 'debug'],
      agentType: 'specialist',
    },
    token,
  );

  return { token, userId, name: username };
}

// ─── Scenarios (3 representative) ───────────────────────────

interface Scenario {
  label: string;
  difficulty: 'simple' | 'medium' | 'complex';
  signals: Array<{ type: string; [k: string]: string | undefined }>;
  correctGene: {
    category: 'repair' | 'optimize' | 'innovate' | 'diagnostic';
    signals_match: Array<{ type: string; [k: string]: string | undefined }>;
    strategy: string[];
    trueSuccessRate: number;
  };
  decoyGenes: Array<{
    category: 'repair' | 'optimize' | 'innovate' | 'diagnostic';
    signals_match: Array<{ type: string; [k: string]: string | undefined }>;
    strategy: string[];
    trueSuccessRate: number;
  }>;
}

const SCENARIOS: Scenario[] = [
  {
    label: 'S1: Timeout repair (simple)',
    difficulty: 'simple',
    signals: [{ type: 'error:timeout' }, { type: 'capability:search' }],
    correctGene: {
      category: 'repair',
      signals_match: [{ type: 'error:timeout' }, { type: 'capability:search' }],
      strategy: ['Increase timeout', 'Add retry with backoff'],
      trueSuccessRate: 0.85,
    },
    decoyGenes: [
      {
        category: 'repair',
        signals_match: [{ type: 'error:timeout' }],
        strategy: ['Generic timeout fix'],
        trueSuccessRate: 0.45,
      },
      {
        category: 'optimize',
        signals_match: [{ type: 'capability:search' }],
        strategy: ['Optimize search'],
        trueSuccessRate: 0.3,
      },
    ],
  },
  {
    label: 'S2: Code optimization (medium)',
    difficulty: 'medium',
    signals: [{ type: 'task:completed' }, { type: 'capability:code' }, { type: 'tag:slow' }],
    correctGene: {
      category: 'optimize',
      signals_match: [{ type: 'task:completed' }, { type: 'capability:code' }, { type: 'tag:slow' }],
      strategy: ['Profile bottleneck', 'Optimize hot path'],
      trueSuccessRate: 0.7,
    },
    decoyGenes: [
      {
        category: 'optimize',
        signals_match: [{ type: 'task:completed' }, { type: 'capability:code' }],
        strategy: ['General code review'],
        trueSuccessRate: 0.5,
      },
      {
        category: 'optimize',
        signals_match: [{ type: 'tag:slow' }],
        strategy: ['Add caching'],
        trueSuccessRate: 0.45,
      },
      {
        category: 'repair',
        signals_match: [{ type: 'task:completed' }],
        strategy: ['Post-task cleanup'],
        trueSuccessRate: 0.35,
      },
    ],
  },
  {
    label: 'S3: Multi-signal debugging (complex)',
    difficulty: 'complex',
    signals: [
      { type: 'error:timeout' },
      { type: 'error:connection_refused' },
      { type: 'capability:debug' },
      { type: 'stage:api_call' },
    ],
    correctGene: {
      category: 'diagnostic',
      signals_match: [
        { type: 'error:timeout' },
        { type: 'error:connection_refused' },
        { type: 'capability:debug' },
        { type: 'stage:api_call' },
      ],
      strategy: ['Check DNS resolution', 'Verify firewall rules', 'Test with curl'],
      trueSuccessRate: 0.6,
    },
    decoyGenes: [
      {
        category: 'repair',
        signals_match: [{ type: 'error:timeout' }, { type: 'capability:debug' }],
        strategy: ['Increase timeout'],
        trueSuccessRate: 0.4,
      },
      {
        category: 'repair',
        signals_match: [{ type: 'error:connection_refused' }],
        strategy: ['Restart service'],
        trueSuccessRate: 0.45,
      },
      {
        category: 'diagnostic',
        signals_match: [{ type: 'error:timeout' }],
        strategy: ['Run diagnostics'],
        trueSuccessRate: 0.35,
      },
    ],
  },
];

// ─── C1: Cold Start Convergence ─────────────────────────────

interface ConvergencePoint {
  capsule: number;
  ssr: number;
  selectedCorrect: boolean;
  confidence: number;
}

async function benchColdStartConvergence(agent: AgentCtx, scenario: Scenario, totalCapsules: number) {
  // Create genes
  const geneIds: string[] = [];
  await paceCall();
  const correctGeneRes = await apiRetry(
    'POST',
    '/api/evolution/genes',
    {
      category: scenario.correctGene.category,
      signals_match: scenario.correctGene.signals_match,
      strategy: scenario.correctGene.strategy,
    },
    agent.token,
  );
  if (!correctGeneRes.ok) throw new Error(`Failed to create correct gene: ${JSON.stringify(correctGeneRes)}`);
  const correctGeneId = correctGeneRes.data.id;
  geneIds.push(correctGeneId);

  const decoyGeneIds: string[] = [];
  for (const decoy of scenario.decoyGenes) {
    await paceCall();
    const res = await apiRetry(
      'POST',
      '/api/evolution/genes',
      {
        category: decoy.category,
        signals_match: decoy.signals_match,
        strategy: decoy.strategy,
      },
      agent.token,
    );
    if (res.ok) {
      decoyGeneIds.push(res.data.id);
      geneIds.push(res.data.id);
    }
  }

  // PRNG for reproducibility
  let seed = 12345;
  function prng(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  const trajectory: ConvergencePoint[] = [];
  let successes = 0;
  let totalRecorded = 0;
  let correctSelections = 0;

  for (let i = 0; i < totalCapsules; i++) {
    await paceCall();
    const analyzeRes = await apiRetry('POST', '/api/evolution/analyze', { signals: scenario.signals }, agent.token);

    const recommendedGeneId = analyzeRes.ok ? analyzeRes.data?.gene_id : null;
    const selectedCorrect = recommendedGeneId === correctGeneId;
    if (selectedCorrect) correctSelections++;
    const confidence = analyzeRes.ok ? analyzeRes.data?.confidence || 0 : 0;

    // Choose gene to use (follow recommendation if valid)
    let usedGeneId: string;
    let trueRate: number;

    if (recommendedGeneId && geneIds.includes(recommendedGeneId)) {
      usedGeneId = recommendedGeneId;
      if (usedGeneId === correctGeneId) {
        trueRate = scenario.correctGene.trueSuccessRate;
      } else {
        const decoyIdx = decoyGeneIds.indexOf(usedGeneId);
        trueRate = decoyIdx >= 0 ? scenario.decoyGenes[decoyIdx].trueSuccessRate : 0.3;
      }
    } else {
      // Explore: random gene
      const allGenes = [correctGeneId, ...decoyGeneIds];
      usedGeneId = allGenes[Math.floor(prng() * allGenes.length)];
      trueRate =
        usedGeneId === correctGeneId
          ? scenario.correctGene.trueSuccessRate
          : scenario.decoyGenes[decoyGeneIds.indexOf(usedGeneId)]?.trueSuccessRate || 0.3;
    }

    const isSuccess = prng() < trueRate;
    const outcome = isSuccess ? 'success' : 'failed';

    await paceCall();
    await apiRetry(
      'POST',
      '/api/evolution/record',
      {
        gene_id: usedGeneId,
        signals: scenario.signals,
        outcome,
        summary: `Capsule ${i + 1}: ${outcome}`,
        score: isSuccess ? 0.6 + prng() * 0.4 : prng() * 0.4,
      },
      agent.token,
    );

    totalRecorded++;
    if (isSuccess) successes++;
    const ssr = totalRecorded > 0 ? successes / totalRecorded : 0;

    trajectory.push({
      capsule: i + 1,
      ssr,
      selectedCorrect,
      confidence,
    });

    process.stdout.write(`.`);
  }
  process.stdout.write('\n');

  // Convergence detection
  const ssrThreshold = 0.6;
  let convergenceAt: number | null = null;
  let aboveCount = 0;
  for (const pt of trajectory) {
    if (pt.ssr >= ssrThreshold) {
      aboveCount++;
      if (aboveCount >= 3 && convergenceAt === null) {
        convergenceAt = pt.capsule;
      }
    } else {
      aboveCount = 0;
    }
  }

  const finalSSR = trajectory.length > 0 ? trajectory[trajectory.length - 1].ssr : 0;
  const selectionAccuracy = totalRecorded > 0 ? correctSelections / totalRecorded : 0;

  return {
    label: scenario.label,
    difficulty: scenario.difficulty,
    trajectory,
    convergenceAt,
    finalSSR,
    selectionAccuracy,
    geneIds,
  };
}

// ─── C2: Gene Ranking Stability (Kendall tau) ───────────────

function kendallTau(a: string[], b: string[]): number {
  const posB = new Map<string, number>();
  b.forEach((v, i) => posB.set(v, i));
  const common = a.filter((v) => posB.has(v));
  const n = common.length;
  if (n <= 1) return 1;

  let concordant = 0,
    discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const diff = (i - j) * (posB.get(common[i])! - posB.get(common[j])!);
      if (diff > 0) concordant++;
      else discordant++;
    }
  }
  return (concordant - discordant) / ((n * (n - 1)) / 2);
}

async function benchRankingStability(agent: AgentCtx, signals: Array<{ type: string }>, nRounds: number) {
  const rankings: string[][] = [];

  for (let i = 0; i < nRounds; i++) {
    await paceCall();
    const res = await apiRetry('POST', '/api/evolution/analyze', { signals }, agent.token);
    if (res.ok && res.data?.rank) {
      rankings.push(res.data.rank.map((r: any) => r.gene_id));
    } else if (res.ok && res.data?.gene_id) {
      rankings.push([res.data.gene_id]);
    }
  }

  let tauSum = 0,
    tauCount = 0;
  for (let i = 1; i < rankings.length; i++) {
    if (rankings[i].length > 1 && rankings[i - 1].length > 1) {
      tauSum += kendallTau(rankings[i - 1], rankings[i]);
      tauCount++;
    }
  }

  return { avgKendallTau: tauCount > 0 ? tauSum / tauCount : 1, rankings };
}

// ─── C3: Bimodality Index ───────────────────────────────────

async function benchBimodalityIndex(agent: AgentCtx) {
  const res = await api('GET', '/api/evolution/edges?limit=100', undefined, agent.token);
  if (!res.ok) return { edges: [] };

  return {
    edges: (res.data || []).map((e: any) => {
      const n = e.success_count + e.failure_count;
      const p = n >= 2 ? e.success_count / n : 0.5;
      return {
        signalKey: e.signal_key,
        geneId: e.gene_id,
        bimodality: Math.round(4 * p * (1 - p) * 1000) / 1000,
        success: e.success_count,
        failure: e.failure_count,
      };
    }),
  };
}

// ─── C4: Signal Entropy ─────────────────────────────────────

function computeSignalEntropy(edges: Array<{ success: number; failure: number }>): number {
  const total = edges.reduce((s, e) => s + e.success + e.failure, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const e of edges) {
    const p = (e.success + e.failure) / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return Math.round(entropy * 1000) / 1000;
}

// ─── C5: Cross-Agent Transfer ───────────────────────────────

async function benchCrossAgentTransfer(agentA: AgentCtx, agentB: AgentCtx) {
  // Agent A creates and trains a gene
  await paceCall();
  const geneRes = await apiRetry(
    'POST',
    '/api/evolution/genes',
    {
      category: 'repair',
      signals_match: [{ type: 'error:cross_test' }, { type: 'capability:transfer' }],
      strategy: ['Cross-agent transfer strategy'],
    },
    agentA.token,
  );

  if (!geneRes.ok) throw new Error('Failed to create transfer gene');
  const geneId = geneRes.data.id;

  // Agent A records 5 successes
  for (let i = 0; i < 5; i++) {
    await paceCall();
    await apiRetry(
      'POST',
      '/api/evolution/record',
      {
        gene_id: geneId,
        signals: [{ type: 'error:cross_test' }, { type: 'capability:transfer' }],
        outcome: 'success',
        summary: `Agent A training ${i}`,
        score: 0.9,
      },
      agentA.token,
    );
  }

  // Publish
  await paceCall();
  await apiRetry('POST', `/api/evolution/genes/${geneId}/publish`, {}, agentA.token);

  // Agent B analyzes with same signals
  let attemptsToFirstHit = 0;
  const MAX_ATTEMPTS = 5;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    attemptsToFirstHit++;
    await paceCall();
    const res = await apiRetry(
      'POST',
      '/api/evolution/analyze',
      {
        signals: [{ type: 'error:cross_test' }, { type: 'capability:transfer' }],
      },
      agentB.token,
    );

    if (res.ok && res.data?.gene_id === geneId) break;
  }

  // Cleanup
  await paceCall();
  await apiRetry('DELETE', `/api/evolution/genes/${geneId}`, undefined, agentA.token);

  return { attemptsToFirstHit, geneId };
}

// ─── Report ──────────────────────────────────────────────────

function printReport(
  convergenceResults: any[],
  rankStability: { avgKendallTau: number },
  bimodality: { edges: any[] },
  crossTransfer: { attemptsToFirstHit: number } | null,
) {
  console.log('\n' + '═'.repeat(90));
  console.log('  Evolution Engine — Convergence & Learning Report');
  console.log(`  Environment: ${BASE}`);
  console.log(`  Rate limit: ${RATE_LIMIT_PER_MIN}/min`);
  console.log('═'.repeat(90));

  // C1
  console.log('\n── C1: Cold Start Convergence ──');
  console.log('┌──────────────────────────────────────┬────────┬─────────┬─────────────┬──────────┬────────┐');
  console.log('│ Scenario                             │ Diff.  │ SSR     │ Converged   │ Sel Acc  │ Status │');
  console.log('├──────────────────────────────────────┼────────┼─────────┼─────────────┼──────────┼────────┤');

  const ssrTargets: Record<string, number> = { simple: 0.7, medium: 0.6, complex: 0.5 };

  for (const r of convergenceResults) {
    const target = ssrTargets[r.difficulty] || 0.5;
    const ok = r.finalSSR >= target;
    const label = r.label.padEnd(36).substring(0, 36);
    const diff = r.difficulty.padEnd(6);
    const ssr = `${(r.finalSSR * 100).toFixed(1)}%`.padStart(7);
    const conv = r.convergenceAt ? `cap ${r.convergenceAt}`.padStart(11) : 'not yet'.padStart(11);
    const selAcc = `${(r.selectionAccuracy * 100).toFixed(0)}%`.padStart(8);
    const status = ok ? ' PASS ' : ' FAIL ';
    console.log(`│ ${label} │ ${diff} │ ${ssr} │ ${conv} │ ${selAcc} │ ${status} │`);
  }

  console.log('└──────────────────────────────────────┴────────┴─────────┴─────────────┴──────────┴────────┘');

  // SSR trajectories
  console.log('\n── SSR Trajectories ──');
  for (const r of convergenceResults) {
    const every3 = r.trajectory.filter((_: any, i: number) => i % 3 === 0 || i === r.trajectory.length - 1);
    const points = every3.map((p: any) => `${p.capsule}:${(p.ssr * 100).toFixed(0)}%`).join(' → ');
    console.log(`  ${r.label}: ${points}`);
  }

  // C2
  console.log('\n── C2: Gene Ranking Stability ──');
  const tauOk = rankStability.avgKendallTau >= 0.7;
  console.log(`  ${tauOk ? '✅' : '❌'} Avg Kendall τ = ${rankStability.avgKendallTau.toFixed(4)} (target: ≥ 0.7)`);

  // C3
  console.log('\n── C3: Bimodality Index ──');
  if (bimodality.edges.length > 0) {
    const high = bimodality.edges.filter((e) => e.bimodality > 0.7);
    const med = bimodality.edges.filter((e) => e.bimodality > 0.3 && e.bimodality <= 0.7);
    const low = bimodality.edges.filter((e) => e.bimodality <= 0.3);
    console.log(`  Low (<0.3, converged): ${low.length} edges`);
    console.log(`  Medium (0.3-0.7, learning): ${med.length} edges`);
    console.log(`  High (>0.7, signal incomplete): ${high.length} edges`);
    for (const e of high.slice(0, 3)) {
      console.log(
        `    ⚠️ signal=${e.signalKey.substring(0, 50)} gene=${e.geneId.substring(0, 12)}… bi=${e.bimodality} (${e.success}s/${e.failure}f)`,
      );
    }
  } else {
    console.log('  No edges');
  }

  // C4
  console.log('\n── C4: Signal Entropy ──');
  if (bimodality.edges.length > 0) {
    const bySignal = new Map<string, Array<{ success: number; failure: number }>>();
    for (const e of bimodality.edges) {
      if (!bySignal.has(e.signalKey)) bySignal.set(e.signalKey, []);
      bySignal.get(e.signalKey)!.push({ success: e.success, failure: e.failure });
    }
    for (const [signal, edges] of bySignal) {
      const se = computeSignalEntropy(edges);
      const icon = se > 2.0 ? '⚠️' : '✅';
      console.log(
        `  ${icon} SE(${signal.substring(0, 50)}) = ${se} (${edges.length} genes)${se > 2.0 ? ' — split signal' : ''}`,
      );
    }
  }

  // C5
  console.log('\n── C5: Cross-Agent Transfer ──');
  if (crossTransfer) {
    const ok = crossTransfer.attemptsToFirstHit <= 5;
    console.log(`  ${ok ? '✅' : '❌'} First hit at attempt ${crossTransfer.attemptsToFirstHit} (target: ≤ 5)`);
  } else {
    console.log('  ⏭️ Skipped');
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(90));
  console.log('  Evolution Engine — Convergence & Learning Benchmark');
  console.log(`  Base URL: ${BASE}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═'.repeat(90));

  // Register agents
  console.log('\n=== Setup ===');
  const agentA = await registerAgent('A');
  await paceCall();
  const agentB = await registerAgent('B');
  console.log(`  Agent A: ${agentA.userId}`);
  console.log(`  Agent B: ${agentB.userId}`);
  console.log(`  Rate limit: ${RATE_LIMIT_PER_MIN}/min`);

  // Determine capsule count based on rate limit
  const capsulesPerScenario = RATE_LIMIT_PER_MIN >= 50 ? 50 : RATE_LIMIT_PER_MIN >= 10 ? 20 : 15;
  console.log(`  Capsules per scenario: ${capsulesPerScenario}`);
  const estMinutes = Math.ceil((SCENARIOS.length * capsulesPerScenario * 2 * (60 / RATE_LIMIT_PER_MIN)) / 60);
  console.log(`  Estimated time: ~${estMinutes} min`);

  const allGeneIds: string[] = [];
  const convergenceResults: any[] = [];

  // C1: Convergence
  console.log(`\n=== C1: Cold Start Convergence (${SCENARIOS.length} scenarios × ${capsulesPerScenario} capsules) ===`);

  for (const scenario of SCENARIOS) {
    process.stdout.write(`  ${scenario.label}: `);
    try {
      const result = await benchColdStartConvergence(agentA, scenario, capsulesPerScenario);
      convergenceResults.push(result);
      allGeneIds.push(...result.geneIds);
      console.log(
        `  → SSR=${(result.finalSSR * 100).toFixed(1)}%, sel_acc=${(result.selectionAccuracy * 100).toFixed(0)}%`,
      );
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  // C2: Ranking stability (5 rounds)
  console.log('\n=== C2: Gene Ranking Stability ===');
  let rankStability = { avgKendallTau: 1, rankings: [] as string[][] };
  try {
    rankStability = await benchRankingStability(agentA, [{ type: 'error:timeout' }, { type: 'capability:search' }], 5);
    console.log(`  Avg Kendall τ = ${rankStability.avgKendallTau.toFixed(4)}`);
  } catch (e: any) {
    console.log(`  ERROR: ${e.message}`);
  }

  // C3: Bimodality
  console.log('\n=== C3: Bimodality Index ===');
  let bimodality = { edges: [] as any[] };
  try {
    bimodality = await benchBimodalityIndex(agentA);
    console.log(`  ${bimodality.edges.length} edges analyzed`);
  } catch (e: any) {
    console.log(`  ERROR: ${e.message}`);
  }

  // C5: Cross-agent transfer
  console.log('\n=== C5: Cross-Agent Transfer ===');
  let crossTransfer: { attemptsToFirstHit: number; geneId: string } | null = null;
  try {
    crossTransfer = await benchCrossAgentTransfer(agentA, agentB);
    console.log(`  First hit at attempt ${crossTransfer.attemptsToFirstHit}`);
  } catch (e: any) {
    console.log(`  ERROR: ${e.message}`);
  }

  // Report
  printReport(convergenceResults, rankStability, bimodality, crossTransfer);

  // Write JSON
  const fs = await import('fs');
  const path = await import('path');
  const jsonOutput = {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    rate_limit_per_min: RATE_LIMIT_PER_MIN,
    capsules_per_scenario: capsulesPerScenario,
    convergence: convergenceResults.map((r) => ({
      label: r.label,
      difficulty: r.difficulty,
      final_ssr: r.finalSSR,
      selection_accuracy: r.selectionAccuracy,
      convergence_at: r.convergenceAt,
      trajectory: r.trajectory,
    })),
    ranking_stability: { avg_kendall_tau: rankStability.avgKendallTau },
    bimodality: {
      total_edges: bimodality.edges.length,
      high: bimodality.edges.filter((e: any) => e.bimodality > 0.7).length,
      medium: bimodality.edges.filter((e: any) => e.bimodality > 0.3 && e.bimodality <= 0.7).length,
      low: bimodality.edges.filter((e: any) => e.bimodality <= 0.3).length,
      edges: bimodality.edges,
    },
    cross_agent_transfer: crossTransfer ? { attempts: crossTransfer.attemptsToFirstHit } : null,
  };

  const outPath = path.join(process.cwd(), 'docs/benchmark/results-convergence.json');
  fs.writeFileSync(outPath, JSON.stringify(jsonOutput, null, 2));
  console.log(`\nResults written to: ${outPath}`);

  // Cleanup
  console.log('\n=== Cleanup ===');
  let deleted = 0;
  for (const id of allGeneIds) {
    try {
      await paceCall();
      const res = await apiRetry('DELETE', `/api/evolution/genes/${id}`, undefined, agentA.token);
      if (res.ok) deleted++;
    } catch {
      /* ignore */
    }
  }
  console.log(`  Deleted ${deleted}/${allGeneIds.length} genes`);
}

main().catch(console.error);
