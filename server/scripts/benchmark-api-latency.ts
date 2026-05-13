/**
 * Prismer Cloud — API Latency Benchmark
 *
 * Measures p50/p95/p99/min/max/avg latency for 16 critical API endpoints.
 * Each endpoint is hit 10 times serially; results are compared against target latencies.
 *
 * Usage:
 *   npx tsx scripts/benchmark-api-latency.ts                # default: test
 *   npx tsx scripts/benchmark-api-latency.ts --env test     # cloud.prismer.dev
 *   npx tsx scripts/benchmark-api-latency.ts --env prod     # prismer.cloud
 *
 * Output:
 *   Console table + JSON report to docs/v181-latency-report-{env}.json
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

// ==============================================================================
// Configuration
// ==============================================================================

const args = process.argv.slice(2);
const argEnv = args.indexOf('--env') !== -1 ? args[args.indexOf('--env') + 1] : undefined;

const ENV = argEnv || process.env.TEST_ENV || 'test';

const BASE_URLS: Record<string, string> = {
  local: 'http://localhost:3000',
  test: 'https://cloud.prismer.dev',
  prod: 'https://prismer.cloud',
};

const API_KEYS: Record<string, string> = {
  test: 'sk-prismer-live-REDACTED-SET-VIA-ENV',
  prod: 'sk-prismer-live-REDACTED-SET-VIA-ENV',
};

const BASE = process.env.BASE_URL || BASE_URLS[ENV] || BASE_URLS.test;
const API_KEY = process.env.API_KEY || API_KEYS[ENV] || '';

const ITERATIONS = 10;

// ==============================================================================
// Endpoint Definitions
// ==============================================================================

interface EndpointDef {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  auth: boolean;
  targetMs: number;
}

const ENDPOINTS: EndpointDef[] = [
  {
    name: 'GET /api/health',
    method: 'GET',
    path: '/api/health',
    auth: false,
    targetMs: 500,
  },
  {
    name: 'GET /api/im/health',
    method: 'GET',
    path: '/api/im/health',
    auth: false,
    targetMs: 500,
  },
  {
    name: 'POST /api/im/memory/files (write)',
    method: 'POST',
    path: '/api/im/memory/files',
    body: { path: 'bench/test.md', content: '# Bench' },
    auth: true,
    targetMs: 500,
  },
  {
    name: 'GET /api/im/memory/files (list)',
    method: 'GET',
    path: '/api/im/memory/files',
    auth: true,
    targetMs: 300,
  },
  {
    name: 'GET /api/im/recall?q=bench',
    method: 'GET',
    path: '/api/im/recall?q=bench',
    auth: true,
    targetMs: 1000,
  },
  {
    name: 'POST /api/im/evolution/analyze',
    method: 'POST',
    path: '/api/im/evolution/analyze',
    body: { signals: [{ type: 'error:test' }], provider: 'bench' },
    auth: true,
    targetMs: 2000,
  },
  {
    name: 'GET /api/im/evolution/public/stats',
    method: 'GET',
    path: '/api/im/evolution/public/stats',
    auth: false,
    targetMs: 500,
  },
  {
    name: 'GET /api/im/evolution/public/genes?limit=5',
    method: 'GET',
    path: '/api/im/evolution/public/genes?limit=5',
    auth: false,
    targetMs: 500,
  },
  {
    name: 'GET /api/im/evolution/leaderboard/stats',
    method: 'GET',
    path: '/api/im/evolution/leaderboard/stats',
    auth: false,
    targetMs: 500,
  },
  {
    name: 'GET /api/im/evolution/leaderboard/agents?period=weekly',
    method: 'GET',
    path: '/api/im/evolution/leaderboard/agents?period=weekly',
    auth: false,
    targetMs: 1000,
  },
  {
    name: 'GET /api/im/evolution/leaderboard/hero',
    method: 'GET',
    path: '/api/im/evolution/leaderboard/hero',
    auth: false,
    targetMs: 500,
  },
  {
    name: 'GET /api/im/community/posts?limit=5',
    method: 'GET',
    path: '/api/im/community/posts?limit=5',
    auth: false,
    targetMs: 500,
  },
  {
    name: 'GET /api/im/community/stats',
    method: 'GET',
    path: '/api/im/community/stats',
    auth: false,
    targetMs: 500,
  },
  {
    name: 'GET /api/im/contacts/friends',
    method: 'GET',
    path: '/api/im/contacts/friends',
    auth: true,
    targetMs: 500,
  },
  {
    name: 'POST /api/context/load',
    method: 'POST',
    path: '/api/context/load',
    body: { input: 'https://example.com', return: { format: 'hqcc' } },
    auth: true,
    targetMs: 10000,
  },
  {
    name: 'GET /api/im/skills/search',
    method: 'GET',
    path: '/api/im/skills/search',
    auth: false,
    targetMs: 500,
  },
];

// ==============================================================================
// Stats Helpers
// ==============================================================================

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
  return sorted[Math.max(0, idx)];
}

interface EndpointStats {
  name: string;
  method: string;
  path: string;
  targetMs: number;
  iterations: number;
  success: number;
  failed: number;
  rateLimited: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  withinTarget: boolean;
  errors: string[];
}

function computeStats(ep: EndpointDef, latencies: number[], errors: string[], rateLimited: number): EndpointStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;
  const p95 = Math.round(percentile(sorted, 95));

  return {
    name: ep.name,
    method: ep.method,
    path: ep.path,
    targetMs: ep.targetMs,
    iterations: latencies.length + errors.length + rateLimited,
    success: latencies.length,
    failed: errors.length,
    rateLimited,
    avg,
    p50: Math.round(percentile(sorted, 50)),
    p95,
    p99: Math.round(percentile(sorted, 99)),
    min: Math.round(sorted[0] ?? 0),
    max: Math.round(sorted.at(-1) ?? 0),
    withinTarget: p95 <= ep.targetMs,
    errors: [...new Set(errors)].slice(0, 3),
  };
}

// ==============================================================================
// HTTP Client
// ==============================================================================

async function fetchEndpoint(ep: EndpointDef): Promise<{ latencyMs: number; status: number; error?: string }> {
  const url = `${BASE}${ep.path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.auth && API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: ep.method,
      headers,
      body: ep.body ? JSON.stringify(ep.body) : undefined,
    });
    const latencyMs = performance.now() - start;

    // Consume body to complete the request cycle
    await res.text();

    if (res.status === 429) {
      return { latencyMs, status: res.status, error: 'rate_limited' };
    }
    if (res.status >= 500) {
      return { latencyMs, status: res.status, error: `HTTP ${res.status}` };
    }

    return { latencyMs, status: res.status };
  } catch (err: any) {
    const latencyMs = performance.now() - start;
    return { latencyMs, status: 0, error: err.message || 'fetch_error' };
  }
}

// ==============================================================================
// Console Table Rendering
// ==============================================================================

function pad(s: string, len: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return s.padStart(len);
  return s.padEnd(len);
}

function printTable(results: EndpointStats[]) {
  const cols = [
    { header: 'Endpoint', width: 50, align: 'left' as const },
    { header: 'OK', width: 5, align: 'right' as const },
    { header: 'Avg', width: 8, align: 'right' as const },
    { header: 'P50', width: 8, align: 'right' as const },
    { header: 'P95', width: 8, align: 'right' as const },
    { header: 'P99', width: 8, align: 'right' as const },
    { header: 'Min', width: 8, align: 'right' as const },
    { header: 'Max', width: 8, align: 'right' as const },
    { header: 'Target', width: 8, align: 'right' as const },
    { header: 'Status', width: 8, align: 'left' as const },
  ];

  const sep = cols.map((c) => '-'.repeat(c.width)).join('-+-');
  const headerLine = cols.map((c) => pad(c.header, c.width, c.align)).join(' | ');

  console.log('');
  console.log(headerLine);
  console.log(sep);

  for (const r of results) {
    const statusIcon = r.failed > 0 ? 'FAIL' : r.withinTarget ? 'PASS' : 'SLOW';
    const statusPrefix = r.failed > 0 ? '  x ' : r.withinTarget ? '  * ' : '  ~ ';
    const line = [
      pad(r.name, cols[0].width, cols[0].align),
      pad(`${r.success}/${r.iterations}`, cols[1].width, cols[1].align),
      pad(`${r.avg}ms`, cols[2].width, cols[2].align),
      pad(`${r.p50}ms`, cols[3].width, cols[3].align),
      pad(`${r.p95}ms`, cols[4].width, cols[4].align),
      pad(`${r.p99}ms`, cols[5].width, cols[5].align),
      pad(`${r.min}ms`, cols[6].width, cols[6].align),
      pad(`${r.max}ms`, cols[7].width, cols[7].align),
      pad(`${r.targetMs}ms`, cols[8].width, cols[8].align),
      pad(`${statusPrefix}${statusIcon}`, cols[9].width, cols[9].align),
    ].join(' | ');
    console.log(line);
  }

  console.log(sep);
}

// ==============================================================================
// Main
// ==============================================================================

async function run() {
  console.log(`\n=== Prismer Cloud API Latency Benchmark ===`);
  console.log(`    Environment : ${ENV} (${BASE})`);
  console.log(`    API Key     : ${API_KEY ? 'set' : 'NOT SET'}`);
  console.log(`    Iterations  : ${ITERATIONS} per endpoint`);
  console.log(`    Endpoints   : ${ENDPOINTS.length}`);
  console.log(`    Date        : ${new Date().toISOString()}\n`);

  if (!API_KEY && ENV !== 'local') {
    console.error('[BenchmarkError] No API key for remote environment. Set API_KEY or use --env local');
    process.exit(1);
  }

  const allResults: EndpointStats[] = [];
  const benchStart = Date.now();

  for (const ep of ENDPOINTS) {
    process.stdout.write(`  Benchmarking: ${ep.name} ...`);

    const latencies: number[] = [];
    const errors: string[] = [];
    let rateLimited = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const result = await fetchEndpoint(ep);

      if (result.error === 'rate_limited') {
        rateLimited++;
        // Wait before next attempt
        await new Promise((r) => setTimeout(r, 2000));
      } else if (result.error) {
        errors.push(result.error);
      } else {
        latencies.push(result.latencyMs);
      }

      // Small gap between requests to avoid hammering
      if (i < ITERATIONS - 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const stats = computeStats(ep, latencies, errors, rateLimited);
    allResults.push(stats);

    const icon = stats.failed > 0 ? ' x' : stats.withinTarget ? ' *' : ' ~';
    process.stdout.write(`${icon} p95=${stats.p95}ms (target ${stats.targetMs}ms)\n`);
  }

  const benchDurationSec = ((Date.now() - benchStart) / 1000).toFixed(1);

  // ─── Console Table ───
  printTable(allResults);

  // ─── Summary ───
  const passCount = allResults.filter((r) => r.withinTarget && r.failed === 0).length;
  const slowCount = allResults.filter((r) => !r.withinTarget && r.failed === 0).length;
  const failCount = allResults.filter((r) => r.failed > 0).length;

  console.log('');
  console.log(`Summary: ${passCount} PASS, ${slowCount} SLOW, ${failCount} FAIL  (${benchDurationSec}s total)`);
  console.log(`  * PASS = p95 within target, all requests succeeded`);
  console.log(`  ~ SLOW = p95 exceeds target, but requests succeeded`);
  console.log(`  x FAIL = one or more requests returned error\n`);

  // ─── JSON Report ───
  const report = {
    benchmark: 'api-latency',
    version: 'v1.8.1',
    env: ENV,
    base: BASE,
    date: new Date().toISOString(),
    iterations: ITERATIONS,
    durationSec: parseFloat(benchDurationSec),
    summary: { total: allResults.length, pass: passCount, slow: slowCount, fail: failCount },
    results: allResults,
  };

  const outPath = resolve(__dirname, '..', 'docs', `v181-latency-report-${ENV}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`Report written to: ${outPath}\n`);
}

run().catch((err) => {
  console.error('[BenchmarkFatal]', err);
  process.exit(1);
});
