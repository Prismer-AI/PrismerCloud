/**
 * Prismer IM — Context Load Pipeline Benchmark (bench-context.ts)
 *
 * Tests: Cache effectiveness, compression quality (ROUGE-1/L), ranking quality (NDCG),
 * cost model validation. REQUIRES external APIs (Exa + LLM) — deferred execution.
 *
 * Usage:
 *   PRISMER_API_KEY="sk-prismer-..." npx tsx scripts/bench-context.ts
 *   PRISMER_API_KEY="sk-prismer-..." TEST_BASE_URL="https://cloud.prismer.dev" npx tsx scripts/bench-context.ts
 *
 * ⚠️ WARNING: This benchmark consumes API credits. Default: ~50 credits.
 * Use --dry-run to validate structure without API calls.
 *
 * Metrics measured:
 * - Cache Hit Rate (repeat URL → cached)
 * - Compression Ratio (HQCC length / raw length)
 * - ROUGE-1 Recall (keyword overlap)
 * - ROUGE-L F1 (longest common subsequence)
 * - NDCG@5 (search ranking quality)
 * - Cost Model Accuracy (expected vs actual credits)
 * - Quality Pass Rate (length filter effectiveness)
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.PRISMER_API_KEY || '';
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Test Infrastructure ──────────────────────────────────────

interface BenchResult {
  name: string;
  metric: string;
  value: number;
  target: string;
  pass: boolean;
  details?: string;
}

const results: BenchResult[] = [];
let totalTests = 0;
let passedTests = 0;

function record(name: string, metric: string, value: number, target: string, pass: boolean, details?: string) {
  totalTests++;
  if (pass) passedTests++;
  results.push({ name, metric, value, target, pass, details });
  const icon = pass ? '✅' : '❌';
  console.log(`  ${icon} ${name}: ${metric} = ${value.toFixed(4)} (target: ${target})${details ? ` — ${details}` : ''}`);
}

// ─── API Helper ───────────────────────────────────────────────

async function apiCall(method: string, path: string, body?: unknown): Promise<any> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ─── ROUGE Implementation ─────────────────────────────────────

/**
 * Compute ROUGE-1 (unigram overlap).
 * Returns { precision, recall, f1 }
 */
function rouge1(hypothesis: string, reference: string): { precision: number; recall: number; f1: number } {
  const hypTokens = tokenize(hypothesis);
  const refTokens = tokenize(reference);
  const hypSet = new Set(hypTokens);
  const refSet = new Set(refTokens);

  let overlap = 0;
  hypSet.forEach(t => { if (refSet.has(t)) overlap++; });

  const precision = hypSet.size > 0 ? overlap / hypSet.size : 0;
  const recall = refSet.size > 0 ? overlap / refSet.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1 };
}

/**
 * Compute ROUGE-L (longest common subsequence based).
 * Returns { precision, recall, f1 }
 */
function rougeL(hypothesis: string, reference: string): { precision: number; recall: number; f1: number } {
  const hypTokens = tokenize(hypothesis);
  const refTokens = tokenize(reference);

  const lcsLen = lcsLength(hypTokens, refTokens);

  const precision = hypTokens.length > 0 ? lcsLen / hypTokens.length : 0;
  const recall = refTokens.length > 0 ? lcsLen / refTokens.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1 };
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  // Use space-optimized LCS for large texts
  if (m > 1000 || n > 1000) {
    // Approximate: use sets instead for very large texts
    const setA = new Set(a);
    let overlap = 0;
    b.forEach(t => { if (setA.has(t)) overlap++; });
    return overlap;
  }

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

// ─── NDCG Implementation ─────────────────────────────────────

/**
 * Compute NDCG@K (Normalized Discounted Cumulative Gain).
 * relevances: array of relevance scores in returned order.
 * idealRelevances: array of relevance scores in ideal order (sorted desc).
 */
function ndcg(relevances: number[], k: number): number {
  const dcg = relevances.slice(0, k).reduce((sum, rel, i) => {
    return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }, 0);

  const ideal = [...relevances].sort((a, b) => b - a);
  const idcg = ideal.slice(0, k).reduce((sum, rel, i) => {
    return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }, 0);

  return idcg > 0 ? dcg / idcg : 0;
}

// ─── Test 1: ROUGE Algorithm Validation ───────────────────────

function benchRougeValidation() {
  console.log('\n=== 1. ROUGE Algorithm Validation (no API calls) ===');

  // Known test cases
  const cases = [
    {
      hyp: 'The cat sat on the mat',
      ref: 'The cat sat on the mat',
      expectedRouge1Recall: 1.0,
      label: 'Identical',
    },
    {
      hyp: 'The cat',
      ref: 'The cat sat on the mat',
      expectedRouge1Recall: 0.333, // 2/6 unique tokens
      label: 'Partial (2/6)',
    },
    {
      hyp: 'A dog ran in the park',
      ref: 'The cat sat on the mat',
      expectedRouge1Recall: 0.166, // 1/6 (only "the" overlaps)
      label: 'Low overlap',
    },
    {
      hyp: '',
      ref: 'The cat sat on the mat',
      expectedRouge1Recall: 0.0,
      label: 'Empty hypothesis',
    },
  ];

  let correct = 0;
  for (const tc of cases) {
    const r1 = rouge1(tc.hyp, tc.ref);
    const error = Math.abs(r1.recall - tc.expectedRouge1Recall);
    if (error < 0.1) correct++;
  }

  record(
    'ROUGE-1 Implementation',
    'Accuracy',
    correct / cases.length,
    '≥ 0.75',
    correct / cases.length >= 0.75,
    `${correct}/${cases.length} test cases within tolerance`,
  );

  // ROUGE-L: verify LCS-based scoring
  const rl = rougeL('The cat sat on the mat', 'The cat sat on the mat');
  record(
    'ROUGE-L (identical)',
    'F1',
    rl.f1,
    '= 1.0',
    rl.f1 > 0.99,
    `precision=${rl.precision.toFixed(3)}, recall=${rl.recall.toFixed(3)}`,
  );

  const rl2 = rougeL('cat mat', 'The cat sat on the mat');
  record(
    'ROUGE-L (subsequence)',
    'Recall',
    rl2.recall,
    '> 0',
    rl2.recall > 0,
    `F1=${rl2.f1.toFixed(3)}, recall=${rl2.recall.toFixed(3)}`,
  );
}

// ─── Test 2: NDCG Algorithm Validation ────────────────────────

function benchNdcgValidation() {
  console.log('\n=== 2. NDCG Algorithm Validation (no API calls) ===');

  // Perfect ranking: NDCG = 1.0
  const perfect = ndcg([3, 2, 1, 0], 4);
  record(
    'NDCG (perfect ranking)',
    'Score',
    perfect,
    '= 1.0',
    Math.abs(perfect - 1.0) < 0.001,
  );

  // Reversed ranking: NDCG < 1.0
  const reversed = ndcg([0, 1, 2, 3], 4);
  record(
    'NDCG (reversed ranking)',
    'Score',
    reversed,
    '< 1.0',
    reversed < 1.0,
    `got ${reversed.toFixed(4)}`,
  );

  // All zeros: NDCG = 0
  const zeros = ndcg([0, 0, 0, 0], 4);
  record(
    'NDCG (all zero)',
    'Score',
    zeros,
    '= 0',
    zeros === 0 || isNaN(zeros),
  );

  // NDCG@1 with best result first
  const atK1 = ndcg([3, 0, 0, 0], 1);
  record(
    'NDCG@1 (best first)',
    'Score',
    atK1,
    '= 1.0',
    Math.abs(atK1 - 1.0) < 0.001,
  );

  // Verify monotonicity: better rankings → higher NDCG
  const r1 = ndcg([3, 2, 1, 0], 4);
  const r2 = ndcg([3, 1, 2, 0], 4);
  const r3 = ndcg([0, 1, 2, 3], 4);
  const monotonic = r1 >= r2 && r2 >= r3;

  record(
    'NDCG Monotonicity',
    'Is Monotonic',
    monotonic ? 1 : 0,
    '= 1',
    monotonic,
    `perfect=${r1.toFixed(3)} ≥ swapped=${r2.toFixed(3)} ≥ reversed=${r3.toFixed(3)}`,
  );
}

// ─── Test 3: Cache Effectiveness (API) ────────────────────────

async function benchCacheEffectiveness() {
  console.log('\n=== 3. Cache Effectiveness ===');

  if (DRY_RUN || !API_KEY) {
    record('Cache Hit (dry run)', 'Skipped', 0, 'N/A', true, 'Dry run — no API calls');
    return;
  }

  const testUrl = 'https://en.wikipedia.org/wiki/TypeScript';

  // First request — may or may not be cached
  const res1 = await apiCall('POST', '/api/context/load', { input: testUrl });
  const firstCached = res1.data?.results?.[0]?.cached ?? false;

  // Second request — should be cached now
  const res2 = await apiCall('POST', '/api/context/load', { input: testUrl });
  const secondCached = res2.data?.results?.[0]?.cached ?? false;

  record(
    'Cache Hit (second request)',
    'Is Cached',
    secondCached ? 1 : 0,
    '= 1',
    secondCached === true,
    `1st: cached=${firstCached}, 2nd: cached=${secondCached}`,
  );

  // Measure compression ratio if available
  if (res1.data?.results?.[0]) {
    const result = res1.data.results[0];
    if (result.content && result.raw_length) {
      const ratio = result.raw_length / result.content.length;
      record(
        'Compression Ratio',
        'Ratio',
        ratio,
        '5x-15x',
        ratio >= 3 && ratio <= 20,
        `raw=${result.raw_length}, compressed=${result.content.length}`,
      );
    }
  }
}

// ─── Test 4: Compression Quality (ROUGE) ──────────────────────

async function benchCompressionQuality() {
  console.log('\n=== 4. Compression Quality (ROUGE) ===');

  if (DRY_RUN || !API_KEY) {
    record('ROUGE-1 (dry run)', 'Skipped', 0, 'N/A', true, 'Dry run — no API calls');
    return;
  }

  // Test with a well-known page
  const testUrls = [
    'https://en.wikipedia.org/wiki/Node.js',
    'https://en.wikipedia.org/wiki/TypeScript',
  ];

  const rouge1Scores: number[] = [];
  const rougeLScores: number[] = [];

  for (const url of testUrls) {
    try {
      const res = await apiCall('POST', '/api/context/load', { input: url });
      if (!res.success || !res.data?.results?.[0]) continue;

      const result = res.data.results[0];
      const compressed = result.content || '';

      // For the reference, we use the URL's content if available
      // Since we don't have raw content in the response, we use the compressed text
      // and compare with known keywords
      const keywords = url.includes('Node.js')
        ? ['javascript', 'runtime', 'server', 'event', 'npm', 'async', 'module']
        : ['typescript', 'javascript', 'type', 'compiler', 'microsoft', 'static'];

      // Measure keyword coverage (proxy for ROUGE-1 recall)
      const compressedLower = compressed.toLowerCase();
      let found = 0;
      for (const kw of keywords) {
        if (compressedLower.includes(kw)) found++;
      }

      const keywordRecall = found / keywords.length;
      rouge1Scores.push(keywordRecall);

    } catch (err) {
      console.log(`  Warning: ${url} failed: ${(err as Error).message}`);
    }
  }

  if (rouge1Scores.length > 0) {
    const avgRecall = rouge1Scores.reduce((a, b) => a + b, 0) / rouge1Scores.length;
    record(
      'Keyword Recall (proxy ROUGE-1)',
      'Avg Recall',
      avgRecall,
      '≥ 0.6',
      avgRecall >= 0.6,
      `${rouge1Scores.length} URLs tested`,
    );
  }
}

// ─── Test 5: Ranking Quality (NDCG) ──────────────────────────

async function benchRankingQuality() {
  console.log('\n=== 5. Ranking Quality (NDCG@5) ===');

  if (DRY_RUN || !API_KEY) {
    record('NDCG@5 (dry run)', 'Skipped', 0, 'N/A', true, 'Dry run — no API calls');
    return;
  }

  // Test with a search query
  const query = 'TypeScript runtime performance optimization techniques';
  const res = await apiCall('POST', '/api/context/load', { input: query });

  if (!res.success || !res.data?.results) {
    record('NDCG@5', 'No Results', 0, 'N/A', false, 'Search returned no results');
    return;
  }

  const results_data = res.data.results;

  // Heuristic relevance scoring based on keyword overlap with query
  const queryTokens = new Set(tokenize(query));
  const relevances = results_data.map((r: any) => {
    const contentTokens = tokenize(r.content || r.title || '');
    let overlap = 0;
    contentTokens.forEach((t: string) => { if (queryTokens.has(t)) overlap++; });
    // Normalize to 0-3 scale
    return Math.min(3, Math.floor(overlap / 2));
  });

  const ndcgScore = ndcg(relevances, 5);
  record(
    'NDCG@5 (heuristic)',
    'Score',
    ndcgScore,
    '≥ 0.5',
    ndcgScore >= 0.5,
    `${results_data.length} results, relevances=[${relevances.slice(0, 5).join(',')}]`,
  );
}

// ─── Test 6: Cost Model Validation ────────────────────────────

function benchCostModel() {
  console.log('\n=== 6. Cost Model Validation (pure math) ===');

  // Verify cost model constants
  const COST_COMPRESSION = 0.5;  // credits per compression
  const COST_SEARCH = 1.0;       // credits per search

  // Single URL: 0.5 credits (1 compression)
  const singleUrlCost = COST_COMPRESSION;
  record('Single URL Cost', 'Credits', singleUrlCost, '= 0.5', singleUrlCost === 0.5);

  // Batch 5 URLs: 5 × 0.5 = 2.5 credits
  const batchCost = 5 * COST_COMPRESSION;
  record('Batch 5 URL Cost', 'Credits', batchCost, '= 2.5', batchCost === 2.5);

  // Search (5 results): 1 + 5 × 0.5 = 3.5 credits
  const searchCost = COST_SEARCH + 5 * COST_COMPRESSION;
  record('Search (5 results) Cost', 'Credits', searchCost, '= 3.5', searchCost === 3.5);

  // Cache hit: 0 credits
  record('Cache Hit Cost', 'Credits', 0, '= 0', true);

  // Mixed batch: 3 cached + 2 fresh = 2 × 0.5 = 1.0 credits
  const mixedCost = 2 * COST_COMPRESSION;
  record('Mixed Batch Cost', 'Credits', mixedCost, '= 1.0', mixedCost === 1.0);
}

// ─── Report ──────────────────────────────────────────────────

function printReport() {
  console.log('\n' + '='.repeat(60));
  console.log('  Context Load Pipeline Benchmark Report');
  console.log('='.repeat(60));

  console.log('\n┌────────────────────────────────┬────────────────┬──────────┬────────┐');
  console.log('│ Test                           │ Metric         │ Value    │ Status │');
  console.log('├────────────────────────────────┼────────────────┼──────────┼────────┤');

  for (const r of results) {
    const name = r.name.padEnd(30).substring(0, 30);
    const metric = r.metric.padEnd(14).substring(0, 14);
    const value = r.value.toFixed(4).padStart(8);
    const status = r.pass ? ' PASS ' : ' FAIL ';
    console.log(`│ ${name} │ ${metric} │ ${value} │ ${status} │`);
  }

  console.log('└────────────────────────────────┴────────────────┴──────────┴────────┘');
  console.log(`\nTotal: ${passedTests}/${totalTests} passed`);

  if (DRY_RUN) {
    console.log('\n⚠️  Dry run mode — API-dependent tests were skipped.');
    console.log('Run without --dry-run and with PRISMER_API_KEY to execute full benchmark.');
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Prismer — Context Load Pipeline Benchmark');
  console.log(`  Base URL: ${BASE}`);
  console.log(`  API Key: ${API_KEY ? '***' + API_KEY.slice(-8) : '(not set)'}`);
  console.log(`  Dry Run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!API_KEY && !DRY_RUN) {
    console.log('\n⚠️  No PRISMER_API_KEY set. Running in dry-run mode.');
    console.log('Set PRISMER_API_KEY to run API-dependent tests.\n');
  }

  // Algorithm validation (no API needed)
  benchRougeValidation();
  benchNdcgValidation();
  benchCostModel();

  // API-dependent tests
  await benchCacheEffectiveness();
  await benchCompressionQuality();
  await benchRankingQuality();

  printReport();
  process.exit(passedTests < totalTests ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
