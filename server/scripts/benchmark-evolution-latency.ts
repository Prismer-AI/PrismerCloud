/**
 * Evolution Engine — Latency & Throughput Benchmark
 *
 * Tests:
 * - L1: POST /evolution/analyze latency (serial)
 * - L2: POST /evolution/record latency (serial)
 * - L3: GET /evolution/public/stats latency (serial, 50 calls)
 * - L4: GET /evolution/public/feed latency (serial, 50 calls)
 * - L5: GET /evolution/public/hot latency (serial, 50 calls)
 * - L6: GET /evolution/public/metrics latency (serial, 50 calls)
 * - T1: POST /evolution/analyze throughput (concurrent, if tier allows)
 * - T2: POST /evolution/record throughput (concurrent, if tier allows)
 *
 * Adapts to user trust tier rate limits (auto-detected).
 *
 * Usage:
 *   # Against test environment
 *   TEST_BASE_URL="https://cloud.prismer.dev/api/im" npx tsx scripts/benchmark-evolution-latency.ts
 *
 *   # Against standalone IM server (no rate limit)
 *   DISABLE_RATE_LIMIT=true npx tsx scripts/benchmark-evolution-latency.ts
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';
let TOKEN = '';
let USER_ID = '';

// ─── Percentile / Stats helpers ──────────────────────────────

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
  return sorted[Math.max(0, idx)];
}

interface LatencyResult {
  name: string;
  total: number;
  success: number;
  failed: number;
  rateLimited: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  rps: number;
  errors: string[];
}

function computeStats(
  name: string,
  latencies: number[],
  errors: string[],
  rateLimited: number,
  durationMs: number,
): LatencyResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    name,
    total: latencies.length + errors.length + rateLimited,
    success: latencies.length,
    failed: errors.length,
    rateLimited,
    avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
    p50: Math.round(pct(sorted, 50)),
    p95: Math.round(pct(sorted, 95)),
    p99: Math.round(pct(sorted, 99)),
    min: Math.round(sorted[0] ?? 0),
    max: Math.round(sorted.at(-1) ?? 0),
    rps: durationMs > 0 ? Math.round((latencies.length / durationMs) * 1000 * 100) / 100 : 0,
    errors: [...new Set(errors)].slice(0, 5),
  };
}

function showResult(r: LatencyResult) {
  const icon = r.failed === 0 && r.rateLimited === 0 ? '✅' : r.failed < r.total * 0.05 ? '⚠️' : '❌';
  console.log(`  ${icon} ${r.name}`);
  console.log(
    `     ${r.success}/${r.total} ok | Avg ${r.avg}ms | P50 ${r.p50}ms | P95 ${r.p95}ms | P99 ${r.p99}ms | Min ${r.min}ms | Max ${r.max}ms | ${r.rps} rps`,
  );
  if (r.rateLimited > 0) console.log(`     ⚡ Rate limited: ${r.rateLimited} (waited and retried)`);
  if (r.errors.length) console.log(`     Errors: ${r.errors.join('; ')}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── API Helper with rate limit retry ────────────────────────

interface ApiResult {
  ok: boolean;
  data?: any;
  error?: any;
  status?: number;
  rateLimited?: boolean;
}

async function api(method: string, path: string, body?: unknown, auth = true): Promise<ApiResult> {
  const url = BASE.includes('/api/im') ? `${BASE}${path.replace(/^\/api/, '')}` : `${BASE}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json()) as any;
  const rateLimited = res.status === 429;
  const retryAfter = rateLimited ? parseInt(res.headers.get('Retry-After') || '30', 10) : 0;

  return {
    ...json,
    status: res.status,
    rateLimited,
    error: json.error
      ? typeof json.error === 'object'
        ? json.error.message || JSON.stringify(json.error)
        : json.error
      : undefined,
    _retryAfter: retryAfter,
  } as any;
}

/** Call API with automatic rate limit retry */
async function apiWithRetry(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
  maxRetries = 3,
): Promise<{ result: ApiResult; wasRateLimited: boolean }> {
  let wasRateLimited = false;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await api(method, path, body, auth);
    if (!(result as any).rateLimited) {
      return { result, wasRateLimited };
    }
    wasRateLimited = true;
    const retryAfter = (result as any)._retryAfter || 30;
    process.stdout.write(`⏳${retryAfter}s `);
    await sleep((retryAfter + 1) * 1000);
  }
  return { result: { ok: false, error: 'Rate limit exceeded after retries', rateLimited: true }, wasRateLimited: true };
}

// ─── Setup ───────────────────────────────────────────────────

let DETECTED_TIER = 0;
let RATE_LIMIT_PER_MIN = 2;

async function setup(): Promise<{ geneIds: string[] }> {
  console.log('\n=== Setup: Register agent + create seed genes ===');

  const username = `benchlatency${Date.now()}`;
  const reg = await api(
    'POST',
    '/api/register',
    {
      username,
      displayName: 'Latency Bench Agent',
      type: 'agent',
    },
    false,
  );

  if (!reg.ok) throw new Error(`Registration failed: ${reg.error}`);
  TOKEN = reg.data?.token;
  USER_ID = reg.data?.imUserId;
  console.log(`  Agent: ${USER_ID}`);

  await apiWithRetry('POST', '/api/agents/register', {
    name: 'Latency Bench Agent',
    description: 'Benchmark agent for latency testing',
    capabilities: ['search', 'summarize', 'translate', 'code', 'debug'],
    agentType: 'specialist',
  });

  // Detect rate limit tier by checking first gene creation
  const geneIds: string[] = [];
  const geneConfigs = [
    { category: 'repair', signals: [{ type: 'error:timeout' }, { type: 'capability:search' }] },
    { category: 'repair', signals: [{ type: 'error:connection_refused' }] },
    { category: 'repair', signals: [{ type: 'error:rate_limit' }] },
    { category: 'optimize', signals: [{ type: 'task:completed' }, { type: 'capability:summarize' }] },
    { category: 'optimize', signals: [{ type: 'task:completed' }, { type: 'capability:code' }] },
  ];

  for (const gc of geneConfigs) {
    const { result } = await apiWithRetry('POST', '/api/evolution/genes', {
      category: gc.category,
      signals_match: gc.signals,
      strategy: ['Step 1: Handle signals', 'Step 2: Verify fix'],
    });
    if (result.ok) geneIds.push(result.data.id);
  }

  // Detect tier from X-RateLimit-Limit header
  const probeRes = await fetch(
    BASE.includes('/api/im')
      ? `${BASE}/evolution/analyze`.replace(/\/api\/im/, '/api/im')
      : `${BASE}/api/evolution/analyze`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ signals: [{ type: 'error:timeout' }] }),
    },
  );
  const limitHeader = probeRes.headers.get('X-RateLimit-Limit');
  if (limitHeader) {
    RATE_LIMIT_PER_MIN = parseInt(limitHeader, 10);
    if (RATE_LIMIT_PER_MIN >= 200) DETECTED_TIER = 3;
    else if (RATE_LIMIT_PER_MIN >= 50) DETECTED_TIER = 2;
    else if (RATE_LIMIT_PER_MIN >= 10) DETECTED_TIER = 1;
    else DETECTED_TIER = 0;
  }

  console.log(`  Created ${geneIds.length} genes`);
  console.log(`  Rate limit: ${RATE_LIMIT_PER_MIN}/min (tier ${DETECTED_TIER})`);

  return { geneIds };
}

// ─── Signal pool ─────────────────────────────────────────────

const SIGNAL_POOL = [
  [{ type: 'error:timeout' }, { type: 'capability:search' }],
  [{ type: 'error:connection_refused' }],
  [{ type: 'error:rate_limit' }],
  [{ type: 'task:completed' }, { type: 'capability:summarize' }],
  [{ type: 'task:completed' }, { type: 'capability:code' }],
];

// ─── L1-L2: Analyze & Record Latency (serial with rate limit awareness) ──

async function benchSerialLatency(
  label: string,
  n: number,
  callFn: (i: number) => Promise<ApiResult>,
): Promise<LatencyResult> {
  const latencies: number[] = [];
  const errors: string[] = [];
  let rateLimited = 0;
  const t0 = performance.now();

  // Pace calls based on rate limit
  const delayBetweenCalls = RATE_LIMIT_PER_MIN > 10 ? 0 : Math.ceil(60000 / RATE_LIMIT_PER_MIN) + 500;

  for (let i = 0; i < n; i++) {
    if (delayBetweenCalls > 0 && i > 0) {
      await sleep(delayBetweenCalls);
    }

    const start = performance.now();
    try {
      const res = await callFn(i);
      const elapsed = performance.now() - start;

      if ((res as any).rateLimited) {
        rateLimited++;
        // Wait and retry once
        const retryAfter = (res as any)._retryAfter || 30;
        await sleep((retryAfter + 1) * 1000);
        const retryStart = performance.now();
        const retryRes = await callFn(i);
        const retryElapsed = performance.now() - retryStart;
        if (retryRes.ok) {
          latencies.push(retryElapsed);
        } else {
          errors.push(retryRes.error || 'retry failed');
        }
      } else if (res.ok) {
        latencies.push(elapsed);
      } else {
        errors.push(res.error || `status ${res.status}`);
      }
    } catch (e: any) {
      errors.push(e.message);
    }
  }

  const result = computeStats(label, latencies, errors, rateLimited, performance.now() - t0);
  showResult(result);
  return result;
}

async function benchAnalyzeLatency(n: number): Promise<LatencyResult> {
  console.log(`\n=== L1: POST /evolution/analyze (serial × ${n}) ===`);
  return benchSerialLatency(`L1: analyze (serial)`, n, async (i) => {
    const signals = SIGNAL_POOL[i % SIGNAL_POOL.length];
    return api('POST', '/api/evolution/analyze', { signals });
  });
}

async function benchRecordLatency(n: number, geneIds: string[]): Promise<LatencyResult> {
  console.log(`\n=== L2: POST /evolution/record (serial × ${n}) ===`);
  return benchSerialLatency(`L2: record (serial)`, n, async (i) => {
    const geneId = geneIds[i % geneIds.length];
    const signals = SIGNAL_POOL[i % SIGNAL_POOL.length];
    const outcome = i % 3 === 0 ? 'failed' : 'success';
    return api('POST', '/api/evolution/record', {
      gene_id: geneId,
      signals,
      outcome,
      summary: `Bench record ${i}: ${outcome}`,
      score: outcome === 'success' ? 0.8 : 0.2,
    });
  });
}

// ─── L3-L6: Public endpoint latency (no rate limit) ─────────

async function benchPublicEndpoint(label: string, path: string, n: number): Promise<LatencyResult> {
  console.log(`\n=== ${label}: GET ${path} (serial × ${n}) ===`);
  const latencies: number[] = [];
  const errors: string[] = [];
  const t0 = performance.now();

  for (let i = 0; i < n; i++) {
    const start = performance.now();
    try {
      const res = await api('GET', `/api/evolution/${path}`, undefined, false);
      const elapsed = performance.now() - start;
      if (res.ok) {
        latencies.push(elapsed);
      } else {
        errors.push(res.error || `status ${res.status}`);
      }
    } catch (e: any) {
      errors.push(e.message);
    }
  }

  const result = computeStats(`${label}: ${path} (serial)`, latencies, errors, 0, performance.now() - t0);
  showResult(result);
  return result;
}

// ─── T1-T2: Throughput (only if tier allows) ─────────────────

async function runConcurrent<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function benchThroughput(
  label: string,
  total: number,
  concurrency: number,
  callFn: (i: number) => Promise<ApiResult>,
): Promise<LatencyResult> {
  console.log(`\n=== ${label} (c=${concurrency}, total=${total}) ===`);
  const latencies: number[] = [];
  const errors: string[] = [];
  let rateLimited = 0;
  const t0 = performance.now();

  const tasks = Array.from({ length: total }, (_, i) => async () => {
    const start = performance.now();
    try {
      const res = await callFn(i);
      const elapsed = performance.now() - start;
      if ((res as any).rateLimited) {
        rateLimited++;
      } else if (res.ok) {
        latencies.push(elapsed);
      } else {
        errors.push(res.error || `status ${res.status}`);
      }
    } catch (e: any) {
      errors.push(e.message);
    }
  });

  await runConcurrent(tasks, concurrency);
  const result = computeStats(label, latencies, errors, rateLimited, performance.now() - t0);
  showResult(result);
  return result;
}

// ─── Cleanup ─────────────────────────────────────────────────

async function cleanup(geneIds: string[]) {
  console.log('\n=== Cleanup ===');
  let deleted = 0;
  for (const id of geneIds) {
    const { result } = await apiWithRetry('DELETE', `/api/evolution/genes/${id}`);
    if (result.ok) deleted++;
  }
  console.log(`  Deleted ${deleted}/${geneIds.length} genes`);
}

// ─── Report ──────────────────────────────────────────────────

interface Targets {
  [key: string]: { p50?: number; p95?: number; qps?: number };
}

const TARGETS: Targets = {
  'L1: analyze (serial)': { p50: 50, p95: 200 },
  'L2: record (serial)': { p50: 50, p95: 150 },
  'L3: public/stats (serial)': { p50: 20 },
  'L4: public/feed (serial)': { p50: 30 },
  'L5: public/hot (serial)': { p50: 30 },
  'L6: public/metrics (serial)': { p50: 30 },
  'T1: analyze (c=10)': { qps: 50 },
  'T2: record (c=30)': { qps: 100 },
};

function printReport(allResults: LatencyResult[]) {
  console.log('\n' + '═'.repeat(100));
  console.log('  Evolution Engine — Latency & Throughput Report');
  console.log(`  Environment: ${BASE}`);
  console.log(`  Trust Tier: ${DETECTED_TIER} (${RATE_LIMIT_PER_MIN}/min tool_call)`);
  console.log('═'.repeat(100));

  console.log('\n┌──────────────────────────────────┬───────┬───────┬───────┬───────┬────────┬────────┐');
  console.log('│ Test                             │  P50  │  P95  │  P99  │  Avg  │   RPS  │ Status │');
  console.log('├──────────────────────────────────┼───────┼───────┼───────┼───────┼────────┼────────┤');

  let pass = 0,
    total = 0;

  for (const r of allResults) {
    const target = TARGETS[r.name];
    let ok = r.success > 0; // At minimum, some calls succeeded
    let reason = '';
    if (target?.p50 && r.p50 > target.p50) {
      ok = false;
      reason = `P50 ${r.p50}>${target.p50}`;
    }
    if (target?.p95 && r.p95 > target.p95) {
      ok = false;
      reason = `P95 ${r.p95}>${target.p95}`;
    }
    if (target?.qps && r.rps < target.qps) {
      ok = false;
      reason = `RPS ${r.rps}<${target.qps}`;
    }

    total++;
    if (ok) pass++;

    const name = r.name.padEnd(32).substring(0, 32);
    const p50 = `${r.p50}ms`.padStart(5);
    const p95 = `${r.p95}ms`.padStart(5);
    const p99 = `${r.p99}ms`.padStart(5);
    const avg = `${r.avg}ms`.padStart(5);
    const rps = `${r.rps}`.padStart(6);
    const status = ok ? ' PASS ' : ' FAIL ';
    console.log(`│ ${name} │ ${p50} │ ${p95} │ ${p99} │ ${avg} │ ${rps} │ ${status} │`);
  }

  console.log('└──────────────────────────────────┴───────┴───────┴───────┴───────┴────────┴────────┘');
  console.log(`\nTotal: ${pass}/${total} passed`);

  // Return JSON output
  return {
    timestamp: new Date().toISOString(),
    base_url: BASE,
    trust_tier: DETECTED_TIER,
    rate_limit_per_min: RATE_LIMIT_PER_MIN,
    results: allResults.map((r) => ({
      name: r.name,
      total: r.total,
      success: r.success,
      failed: r.failed,
      rate_limited: r.rateLimited,
      avg_ms: r.avg,
      p50_ms: r.p50,
      p95_ms: r.p95,
      p99_ms: r.p99,
      min_ms: r.min,
      max_ms: r.max,
      rps: r.rps,
      target: TARGETS[r.name] || {},
      pass: (() => {
        const t = TARGETS[r.name];
        if (!t) return r.success > 0;
        if (t.p50 && r.p50 > t.p50) return false;
        if (t.p95 && r.p95 > t.p95) return false;
        if (t.qps && r.rps < t.qps) return false;
        return r.success > 0;
      })(),
    })),
  };
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(100));
  console.log('  Evolution Engine — Latency & Throughput Benchmark');
  console.log(`  Base URL: ${BASE}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═'.repeat(100));

  const { geneIds } = await setup();
  const allResults: LatencyResult[] = [];

  // Determine call count based on rate limit
  const serialCalls = RATE_LIMIT_PER_MIN >= 50 ? 100 : RATE_LIMIT_PER_MIN >= 10 ? 30 : 10;
  const concurrentTotal = RATE_LIMIT_PER_MIN >= 50 ? 100 : 0; // Skip concurrent for low tiers

  console.log(
    `\n  Plan: ${serialCalls} serial calls per endpoint, ${concurrentTotal > 0 ? 'concurrent tests enabled' : 'concurrent tests SKIPPED (low tier)'}`,
  );

  try {
    // L1-L2: Serial latency (rate limited)
    allResults.push(await benchAnalyzeLatency(serialCalls));
    allResults.push(await benchRecordLatency(serialCalls, geneIds));

    // L3-L6: Public endpoints (no rate limit)
    allResults.push(await benchPublicEndpoint('L3', 'public/stats', 50));
    allResults.push(await benchPublicEndpoint('L4', 'public/feed', 50));
    allResults.push(await benchPublicEndpoint('L5', 'public/hot', 50));
    allResults.push(await benchPublicEndpoint('L6', 'public/metrics', 50));

    // T1-T2: Concurrent throughput (only if tier allows)
    if (concurrentTotal > 0) {
      allResults.push(
        await benchThroughput('T1: analyze (c=10)', concurrentTotal, 10, async (i) => {
          return api('POST', '/api/evolution/analyze', { signals: SIGNAL_POOL[i % SIGNAL_POOL.length] });
        }),
      );
      allResults.push(
        await benchThroughput('T2: record (c=30)', concurrentTotal * 3, 30, async (i) => {
          return api('POST', '/api/evolution/record', {
            gene_id: geneIds[i % geneIds.length],
            signals: SIGNAL_POOL[i % SIGNAL_POOL.length],
            outcome: i % 3 === 0 ? 'failed' : 'success',
            summary: `Throughput ${i}`,
            score: 0.7,
          });
        }),
      );
    } else {
      console.log('\n=== T1/T2: Skipped (tier too low for concurrent benchmark) ===');
    }
  } catch (err) {
    console.error('\nFatal error:', err);
  }

  const jsonOutput = printReport(allResults);

  // Write JSON results
  const fs = await import('fs');
  const path = await import('path');
  const outPath = path.join(process.cwd(), 'docs/benchmark/results-latency.json');
  fs.writeFileSync(outPath, JSON.stringify(jsonOutput, null, 2));
  console.log(`\nResults written to: ${outPath}`);

  await cleanup(geneIds);
}

main().catch(console.error);
