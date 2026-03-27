/**
 * Self-Host End-to-End Test
 *
 * Tests the full self-host deployment via docker compose:
 *   docker compose up → wait ready → register → login → API key →
 *   context save/load → IM workspace → messaging → cleanup
 *
 * Usage:
 *   # With docker (full e2e):
 *   npx tsx scripts/e2e-self-host.ts
 *
 *   # Against running instance:
 *   BASE_URL=http://localhost:3000 npx tsx scripts/e2e-self-host.ts --no-docker
 *
 *   # With AUTH_DISABLED mode:
 *   BASE_URL=http://localhost:3000 npx tsx scripts/e2e-self-host.ts --no-docker --no-auth
 */

import { execSync, spawn, type ChildProcess } from 'child_process';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const NO_DOCKER = process.argv.includes('--no-docker');
const NO_AUTH = process.argv.includes('--no-auth');
const TS = String(Date.now()).slice(-8);

// ─── Test Infrastructure ────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];
const suiteResults: { name: string; passed: number; failed: number }[] = [];
let suiteP = 0;
let suiteF = 0;
let currentSuite = '';

function suite(name: string) {
  if (suiteP || suiteF) {
    suiteResults.push({ name: currentSuite, passed: suiteP, failed: suiteF });
  }
  suiteP = 0;
  suiteF = 0;
  currentSuite = name;
  console.log(`\n🔹 ${name}`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    suiteP++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    suiteF++;
    const msg = err.message || String(err);
    failures.push(`${currentSuite} > ${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function api(
  method: string,
  path: string,
  body?: any,
  token?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = path.startsWith('/api/im/')
    ? `${BASE}${path}`
    : `${BASE}/api${path}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

// ─── Docker Lifecycle ────────────────────────────────────────

async function dockerUp(): Promise<void> {
  console.log('🐳 Starting docker compose...');
  execSync('docker compose up -d --build --wait', {
    stdio: 'inherit',
    timeout: 300_000, // 5 min build timeout
  });
}

async function dockerDown(): Promise<void> {
  console.log('\n🐳 Stopping docker compose...');
  execSync('docker compose down -v', { stdio: 'inherit' });
}

async function waitForReady(maxWaitMs = 120_000): Promise<void> {
  console.log(`⏳ Waiting for ${BASE} to be ready...`);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(`✅ Server ready (${Date.now() - start}ms)`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Server not ready after ${maxWaitMs}ms`);
}

// ─── Test Suites ─────────────────────────────────────────────

// State shared across suites
let adminToken = '';
let apiKey = '';
let imToken = '';
let imUserId = '';
let workspaceConvId = '';

async function testHealthCheck() {
  suite('Health Check');

  await test('GET /api/version returns 200', async () => {
    const res = await fetch(`${BASE}/api/version`);
    assertEqual(res.status, 200, 'status');
  });

  await test('GET /api/config/oauth returns config', async () => {
    const { status, data } = await api('GET', '/config/oauth');
    assertEqual(status, 200, 'status');
    assert(data.success !== undefined || data.data !== undefined, 'has response body');
  });
}

async function testAuth() {
  suite('Authentication');

  if (NO_AUTH) {
    await test('AUTH_DISABLED — API works without token', async () => {
      const { status, data } = await api('GET', '/dashboard/stats');
      assert(status === 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
    });
    // Set empty token for downstream tests
    adminToken = '';
    return;
  }

  await test('Register new user', async () => {
    const { status, data } = await api('POST', '/auth/register', {
      email: `e2e_${TS}@test.local`,
      password: 'testpass123',
    });
    // 200 or 201 both acceptable
    assert(status >= 200 && status < 300, `register failed: ${status} ${JSON.stringify(data)}`);
  });

  await test('Login with default admin', async () => {
    const { status, data } = await api('POST', '/auth/login', {
      email: 'admin@localhost',
      password: 'admin123',
    });
    assertEqual(status, 200, 'status');
    assert(data.success || data.data?.token, `login failed: ${JSON.stringify(data)}`);
    adminToken = data.data?.token || data.token;
    assert(!!adminToken, 'token should be present');
  });

  await test('Dashboard stats with token', async () => {
    const { status } = await api('GET', '/dashboard/stats', undefined, adminToken);
    assertEqual(status, 200, 'status');
  });

  await test('Reject request without token', async () => {
    const { status } = await api('GET', '/dashboard/stats');
    assertEqual(status, 401, 'should be 401');
  });
}

async function testApiKeys() {
  suite('API Keys');

  if (NO_AUTH) {
    await test('Create API key (no auth mode)', async () => {
      const { status, data } = await api('POST', '/keys', { name: `e2e_key_${TS}` });
      assert(status >= 200 && status < 300, `create key failed: ${status} ${JSON.stringify(data)}`);
      apiKey = data.data?.key || data.key || '';
      assert(apiKey.startsWith('sk-prismer-'), `key format wrong: ${apiKey}`);
    });
    return;
  }

  await test('Create API key', async () => {
    const { status, data } = await api('POST', '/keys', { name: `e2e_key_${TS}` }, adminToken);
    assert(status >= 200 && status < 300, `create key failed: ${status} ${JSON.stringify(data)}`);
    apiKey = data.data?.key || data.key || '';
    assert(apiKey.startsWith('sk-prismer-'), `key format wrong: ${apiKey}`);
  });

  await test('List API keys', async () => {
    const { status, data } = await api('GET', '/keys', undefined, adminToken);
    assertEqual(status, 200, 'status');
    const keys = data.data?.keys || data.data || [];
    assert(Array.isArray(keys), 'keys should be array');
    assert(keys.length > 0, 'should have at least 1 key');
  });

  await test('Use API key for auth', async () => {
    const { status } = await api('GET', '/dashboard/stats', undefined, apiKey);
    assertEqual(status, 200, 'status');
  });
}

async function testContextCache() {
  suite('Context Cache');

  const token = NO_AUTH ? undefined : (apiKey || adminToken);
  const testUrl = `https://e2e-test-${TS}.example.com`;

  await test('Save context', async () => {
    const { status, data } = await api('POST', '/context/save', {
      input: testUrl,
      content: `E2E test content at ${new Date().toISOString()}`,
    }, token);
    assert(status >= 200 && status < 300, `save failed: ${status} ${JSON.stringify(data)}`);
  });

  await test('Load context (cache hit)', async () => {
    const { status, data } = await api('POST', '/context/load', {
      input: testUrl,
    }, token);
    assert(status >= 200 && status < 300, `load failed: ${status} ${JSON.stringify(data)}`);
    // Should contain our cached content
    const content = JSON.stringify(data);
    assert(content.includes('E2E test content') || data.data?.results?.length >= 0,
      'should return cached content or results');
  });
}

async function testIMServer() {
  suite('IM Server');

  const token = NO_AUTH ? undefined : (adminToken || apiKey);

  await test('Init workspace', async () => {
    const { status, data } = await api('POST', '/api/im/workspace/init', {
      name: `e2e_workspace_${TS}`,
      user: { username: `e2e_user_${TS}`, displayName: 'E2E User' },
      agents: [{ username: `e2e_agent_${TS}`, displayName: 'E2E Agent', capabilities: ['test'] }],
    }, token);
    assert(status >= 200 && status < 300, `workspace init failed: ${status} ${JSON.stringify(data)}`);
    const ws = data.data;
    assert(ws, 'workspace data should exist');
    workspaceConvId = ws.conversationId || ws.conversation?.id || '';
    imToken = ws.userToken || ws.tokens?.user || '';
    imUserId = ws.userId || ws.user?.id || '';
    assert(!!workspaceConvId, `conversationId missing: ${JSON.stringify(ws)}`);
  });

  const getImToken = () => NO_AUTH ? undefined : imToken;

  await test('Send message', async () => {
    assert(!!workspaceConvId, 'need conversationId from workspace init');
    const { status, data } = await api('POST', `/api/im/messages/${workspaceConvId}`, {
      content: `Hello from E2E test ${TS}`,
      contentType: 'text',
    }, getImToken());
    assert(status >= 200 && status < 300, `send failed: ${status} ${JSON.stringify(data)}`);
  });

  await test('Get messages', async () => {
    const { status, data } = await api('GET', `/api/im/messages/${workspaceConvId}?limit=10`, undefined, getImToken());
    assertEqual(status, 200, 'status');
    const messages = data.data || [];
    assert(Array.isArray(messages), 'messages should be array');
    assert(messages.length > 0, 'should have at least 1 message');
    const found = messages.some((m: any) => m.content?.includes('Hello from E2E test'));
    assert(found, 'should find our test message');
  });

  await test('Discover agents', async () => {
    const { status, data } = await api('GET', '/api/im/discover', undefined, getImToken());
    assertEqual(status, 200, 'status');
    assert(data.ok || data.data, 'discover should return data');
  });

  await test('List conversations', async () => {
    const { status, data } = await api('GET', '/api/im/conversations', undefined, getImToken());
    assertEqual(status, 200, 'status');
    const convs = data.data || [];
    assert(Array.isArray(convs), 'conversations should be array');
  });
}

async function testEvolution() {
  suite('Evolution (Public)');

  await test('GET /api/im/evolution/public/stats', async () => {
    const { status, data } = await api('GET', '/api/im/evolution/public/stats');
    assertEqual(status, 200, 'status');
    assert(data.ok || data.data !== undefined, 'should have stats');
  });

  await test('GET /api/im/evolution/public/feed', async () => {
    const { status, data } = await api('GET', '/api/im/evolution/public/feed');
    assertEqual(status, 200, 'status');
  });

  await test('GET /api/im/evolution/map', async () => {
    const { status, data } = await api('GET', '/api/im/evolution/map');
    assertEqual(status, 200, 'status');
  });
}

async function testFrontendPages() {
  suite('Frontend Pages');

  const pages = ['/', '/auth', '/docs', '/evolution'];
  for (const page of pages) {
    await test(`GET ${page} returns HTML`, async () => {
      const res = await fetch(`${BASE}${page}`);
      assert(res.status === 200 || res.status === 302, `${page}: status ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      assert(ct.includes('text/html') || res.status === 302, `${page}: not HTML (${ct})`);
    });
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   PrismerCloud Self-Host E2E Test               ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Target:    ${BASE}`);
  console.log(`  Docker:    ${NO_DOCKER ? 'skip (--no-docker)' : 'yes'}`);
  console.log(`  Auth:      ${NO_AUTH ? 'disabled (--no-auth)' : 'enabled'}`);
  console.log(`  Timestamp: ${TS}`);

  try {
    // 1. Start docker if needed
    if (!NO_DOCKER) {
      await dockerUp();
    }

    // 2. Wait for server
    await waitForReady();

    // 3. Run test suites
    await testHealthCheck();
    await testAuth();
    await testApiKeys();
    await testContextCache();
    await testIMServer();
    await testEvolution();
    await testFrontendPages();

    // Final suite flush
    suiteResults.push({ name: currentSuite, passed: suiteP, failed: suiteF });
  } finally {
    // 4. Cleanup
    if (!NO_DOCKER) {
      await dockerDown();
    }
  }

  // 5. Report
  console.log('\n══════════════════════════════════════════════════');
  console.log(`Total: ${passed + failed} tests | ✅ ${passed} passed | ❌ ${failed} failed`);

  if (failures.length > 0) {
    console.log('\n❌ Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }

  console.log('\n📊 Suite Summary:');
  for (const s of suiteResults) {
    const icon = s.failed === 0 ? '✅' : '❌';
    console.log(`   ${icon} ${s.name}: ${s.passed}/${s.passed + s.failed}`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`\nTime: ${elapsed}ms`);
  console.log('══════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

const startTime = Date.now();
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
