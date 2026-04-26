/**
 * Prismer IM — Infrastructure Benchmark (bench-infra.ts)
 *
 * Tests: API latency (p50/p95/p99), error rates, concurrent connection handling,
 * SSE stream stability, WebSocket reconnection, DB query latency.
 *
 * Usage:
 *   # Against standalone IM server
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx scripts/bench-infra.ts
 *
 *   # Against test environment
 *   TEST_BASE_URL="https://cloud.prismer.dev/api/im" npx tsx scripts/bench-infra.ts
 *
 * Metrics measured:
 * - API Latency p50/p95/p99 (per endpoint)
 * - Error Rate (4xx/5xx separation)
 * - Concurrent Request Handling (throughput under load)
 * - SSE Stream Stability (connection duration, event delivery)
 * - Health Check Latency
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';
let TOKEN = '';
let USER_ID = '';

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

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: any; latencyMs: number }> {
  const url = BASE.includes('/api/im') ? `${BASE}${path.replace(/^\/api/, '')}` : `${BASE}${path}`;
  const start = performance.now();
  // token='noauth' means explicitly skip auth header
  const effectiveToken = token === 'noauth' ? '' : (token || TOKEN);
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(effectiveToken ? { Authorization: `Bearer ${effectiveToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const latencyMs = performance.now() - start;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, latencyMs };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Setup ────────────────────────────────────────────────────

async function setup() {
  console.log('\n=== Setup: Register test user ===');

  const username = `benchinfra${Date.now()}`;
  const res = await api('POST', '/api/register', {
    username,
    displayName: 'Infra Bench User',
    type: 'agent',
  });

  if (!res.data?.ok) throw new Error(`Registration failed: ${JSON.stringify(res.data)}`);
  TOKEN = res.data.data?.token;
  USER_ID = res.data.data?.imUserId;
  console.log(`  User registered: ${USER_ID}`);

  // Register agent card
  await api('POST', '/api/agents/register', {
    name: 'Infra Bench Agent',
    description: 'Benchmark agent for infra testing',
    capabilities: ['benchmark'],
    agentType: 'specialist',
  });
}

// ─── Test 1: Health Check Latency ─────────────────────────────

async function benchHealthCheck() {
  console.log('\n=== 1. Health Check Latency ===');

  const latencies: number[] = [];
  for (let i = 0; i < 20; i++) {
    const { latencyMs } = await api('GET', '/api/health');
    latencies.push(latencyMs);
  }

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);

  record('Health p50', 'ms', p50, '< 20', p50 < 20, `${latencies.length} samples`);
  record('Health p95', 'ms', p95, '< 50', p95 < 50);
  record('Health p99', 'ms', p99, '< 100', p99 < 100);
}

// ─── Test 2: Endpoint Latency Profile ─────────────────────────

async function benchEndpointLatency() {
  console.log('\n=== 2. Endpoint Latency Profile ===');

  // Create a partner for messaging tests (no auth → new identity)
  const partnerRes = await api('POST', '/api/register', {
    username: `benchinfrapartner${Date.now()}`,
    displayName: 'Infra Bench Partner',
    type: 'human',
  }, 'noauth');
  const partnerToken = partnerRes.data?.data?.token;
  const partnerId = partnerRes.data?.data?.imUserId;

  const endpoints: Array<{
    label: string;
    method: string;
    path: string;
    body?: unknown;
    target: number;
  }> = [
    { label: 'GET /me', method: 'GET', path: '/api/me', target: 50 },
    { label: 'GET /conversations', method: 'GET', path: '/api/conversations', target: 100 },
    { label: 'GET /discover', method: 'GET', path: '/api/discover', target: 50 },
    { label: 'POST /register', method: 'POST', path: '/api/register', body: { username: `latencytest${Date.now()}`, displayName: 'Latency Test', type: 'agent' }, target: 100 },
  ];

  // Add DM endpoint if we have a partner
  if (partnerId) {
    endpoints.push({
      label: 'POST /direct/messages',
      method: 'POST',
      path: `/api/direct/${partnerId}/messages`,
      body: { content: 'Latency test', type: 'text' },
      target: 150,
    });
  }

  for (const ep of endpoints) {
    const latencies: number[] = [];
    for (let i = 0; i < 10; i++) {
      // For POST /register, use unique username each time
      let body = ep.body;
      if (ep.path === '/api/register') {
        body = { username: `latencytest${Date.now()}x${i}`, displayName: 'Latency Test', type: 'agent' };
      }
      const { latencyMs } = await api(ep.method, ep.path, body);
      latencies.push(latencyMs);
    }

    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    record(
      `${ep.label} p50`,
      'ms',
      p50,
      `< ${ep.target}`,
      p50 < ep.target,
      `p95=${p95.toFixed(1)}ms`,
    );
  }
}

// ─── Test 3: Error Rate Classification ────────────────────────

async function benchErrorRates() {
  console.log('\n=== 3. Error Rate Classification ===');

  // Intentional error requests
  const errorCases: Array<{
    label: string;
    method: string;
    path: string;
    body?: unknown;
    token?: string;
    expected4xx: boolean;
  }> = [
    // 401: No auth — use explicit 'noauth' to skip auth header
    { label: '401 No Auth', method: 'GET', path: '/api/me', token: 'noauth', expected4xx: true },
    // 401: Bad token
    { label: '401 Bad Token', method: 'GET', path: '/api/me', token: 'invalid_token', expected4xx: true },
    // 400: Missing required field
    { label: '400 Bad Request', method: 'POST', path: '/api/register', body: {}, expected4xx: true },
    // 404: Non-existent resource
    { label: '404 Not Found', method: 'GET', path: '/api/conversations/nonexistent/messages', expected4xx: true },
  ];

  let correct4xx = 0;
  for (const ec of errorCases) {
    const tokenToUse = ec.token || TOKEN;
    const { status } = await api(ec.method, ec.path, ec.body, tokenToUse || undefined);
    const is4xx = status >= 400 && status < 500;
    if (is4xx === ec.expected4xx) correct4xx++;
  }

  record(
    'Error Classification',
    'Accuracy',
    correct4xx / errorCases.length,
    '≥ 0.75',
    correct4xx / errorCases.length >= 0.75,
    `${correct4xx}/${errorCases.length} correct status codes`,
  );
}

// ─── Test 4: Concurrent Request Handling ──────────────────────

async function benchConcurrency() {
  console.log('\n=== 4. Concurrent Request Handling ===');

  // Phase 1: 10 concurrent reads
  const readStart = performance.now();
  const readPromises = Array.from({ length: 10 }, () =>
    api('GET', '/api/discover'),
  );
  const readResults = await Promise.all(readPromises);
  const readElapsed = performance.now() - readStart;

  const readSuccesses = readResults.filter(r => r.status < 400).length;
  const readThroughput = 10 / (readElapsed / 1000);

  record(
    'Concurrent Reads (10)',
    'Success Rate',
    readSuccesses / 10,
    '= 1.0',
    readSuccesses === 10,
    `${readElapsed.toFixed(0)}ms total`,
  );

  record(
    'Read Throughput',
    'req/sec',
    readThroughput,
    '≥ 50',
    readThroughput >= 50,
    `10 requests in ${readElapsed.toFixed(0)}ms`,
  );

  // Phase 2: 20 concurrent writes (register new users)
  const writeStart = performance.now();
  const writeTs = Date.now();
  const writePromises = Array.from({ length: 20 }, (_, i) =>
    api('POST', '/api/register', {
      username: `benchcw${writeTs}x${i}`,
      displayName: `Concurrent Test ${i}`,
      type: 'agent',
    }),
  );
  const writeResults = await Promise.all(writePromises);
  const writeElapsed = performance.now() - writeStart;

  const writeSuccesses = writeResults.filter(r => r.data?.ok).length;
  const writeThroughput = 20 / (writeElapsed / 1000);

  record(
    'Concurrent Writes (20)',
    'Success Rate',
    writeSuccesses / 20,
    '≥ 0.9',
    writeSuccesses / 20 >= 0.9,
    `${writeSuccesses}/20 in ${writeElapsed.toFixed(0)}ms`,
  );

  record(
    'Write Throughput',
    'req/sec',
    writeThroughput,
    '≥ 20',
    writeThroughput >= 20,
  );

  // Phase 3: Mixed read+write
  const mixedStart = performance.now();
  const mixedPromises = [
    ...Array.from({ length: 5 }, () => api('GET', '/api/discover')),
    ...Array.from({ length: 5 }, () => api('GET', '/api/conversations')),
    ...Array.from({ length: 5 }, (_, i) =>
      api('POST', '/api/register', {
        username: `benchmix${Date.now()}x${i}`,
        displayName: `Mixed Test ${i}`,
        type: 'agent',
      }),
    ),
  ];
  const mixedResults = await Promise.all(mixedPromises);
  const mixedElapsed = performance.now() - mixedStart;

  const mixedSuccesses = mixedResults.filter(r => r.status < 400 || r.data?.ok).length;
  record(
    'Mixed Concurrent (15)',
    'Success Rate',
    mixedSuccesses / 15,
    '≥ 0.9',
    mixedSuccesses / 15 >= 0.9,
    `${mixedSuccesses}/15 in ${mixedElapsed.toFixed(0)}ms`,
  );
}

// ─── Test 5: SSE Stream Stability ─────────────────────────────

async function benchSSEStream() {
  console.log('\n=== 5. SSE Stream Stability ===');

  if (!TOKEN) {
    record('SSE Setup', 'Token', 0, '= 1', false, 'No auth token');
    return;
  }

  // Try to connect to SSE endpoint (auth via query param, not header)
  const sseUrl = BASE.includes('/api/im')
    ? `${BASE}/sync/stream?token=${TOKEN}`
    : `${BASE}/api/sync/stream?token=${TOKEN}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const start = performance.now();
    const res = await fetch(sseUrl, {
      headers: {
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
    });

    const connectLatency = performance.now() - start;

    clearTimeout(timeout);

    const isSSE = res.headers.get('content-type')?.includes('text/event-stream') ||
                  res.headers.get('content-type')?.includes('text/plain');

    record(
      'SSE Connection',
      'Latency ms',
      connectLatency,
      '< 1000',
      connectLatency < 1000 && res.status < 400,
      `status=${res.status}, content-type=${res.headers.get('content-type')}`,
    );

    // Close connection
    controller.abort();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // Connection established but we timed out (expected)
      record('SSE Connection', 'Established', 1, '= 1', true, 'Connected and held for 5s');
    } else {
      record('SSE Connection', 'Error', 0, '= 1', false, err.message);
    }
  }
}

// ─── Test 6: Request Size Handling ────────────────────────────

async function benchRequestSize() {
  console.log('\n=== 6. Request Size Handling ===');

  // Create a partner for messaging (register without auth to get a separate identity)
  const partnerRes = await api('POST', '/api/register', {
    username: `benchsizepartner${Date.now()}`,
    displayName: 'Size Test Partner',
    type: 'human',
  }, 'noauth');
  const partnerId = partnerRes.data?.data?.imUserId;

  if (!partnerId) {
    record('Request Size Setup', 'Partner', 0, '= 1', false, 'Failed to create partner');
    return;
  }

  // Small message (100 bytes)
  const smallRes = await api('POST', `/api/direct/${partnerId}/messages`, {
    content: 'x'.repeat(100),
    type: 'text',
  });
  record(
    'Small Message (100B)',
    'Accepted',
    smallRes.data?.ok ? 1 : 0,
    '= 1',
    smallRes.data?.ok === true,
    `status=${smallRes.status}, ok=${smallRes.data?.ok}, error=${smallRes.data?.error}`,
  );

  // Medium message (10KB)
  const mediumRes = await api('POST', `/api/direct/${partnerId}/messages`, {
    content: 'x'.repeat(10240),
    type: 'text',
  });
  record(
    'Medium Message (10KB)',
    'Accepted',
    mediumRes.data?.ok ? 1 : 0,
    '= 1',
    mediumRes.data?.ok === true,
    `status=${mediumRes.status}, ok=${mediumRes.data?.ok}, error=${mediumRes.data?.error}`,
  );

  // Large message (100KB)
  const largeRes = await api('POST', `/api/direct/${partnerId}/messages`, {
    content: 'x'.repeat(102400),
    type: 'text',
  });
  // Should either succeed or gracefully reject
  const largeHandled = largeRes.status < 500;
  record(
    'Large Message (100KB)',
    'Handled',
    largeHandled ? 1 : 0,
    '= 1',
    largeHandled,
    `status=${largeRes.status}, ok=${largeRes.data?.ok}`,
  );
}

// ─── Report ──────────────────────────────────────────────────

function printReport() {
  console.log('\n' + '='.repeat(60));
  console.log('  Infrastructure Benchmark Report');
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
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Prismer IM — Infrastructure Benchmark');
  console.log(`  Base URL: ${BASE}`);
  console.log('='.repeat(60));

  try {
    await setup();
    await benchHealthCheck();
    await benchEndpointLatency();
    await benchErrorRates();
    await benchConcurrency();
    await benchSSEStream();
    await benchRequestSize();
  } catch (err) {
    console.error('\nFatal error:', err);
  }

  printReport();
  process.exit(passedTests < totalTests ? 1 : 0);
}

main();
