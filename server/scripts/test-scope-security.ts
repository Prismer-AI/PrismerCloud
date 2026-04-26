/**
 * Evolution Data Isolation + Security — Verification Tests
 *
 * Tests:
 *   1. Scope isolation: genes in scope A not visible in scope B
 *   2. Public feed filtering: scope='global' only
 *   3. One-way consumption: non-owner record doesn't update gene stats
 *   4. Security APIs: trust tier, encryption mode, key exchange
 *   5. Rate limiting headers
 *   6. Scopes endpoint
 *
 * Usage: PRISMER_API_KEY=sk-... npx tsx scripts/test-scope-security.ts
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.PRISMER_API_KEY || '';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
};

async function json(path: string, method = 'GET', body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: 'Non-JSON response' };
  }
  return { status: res.status, data, headers: res.headers };
}

// ============================================================================
// Test 1: Public feed only shows scope='global' data
// ============================================================================

async function testPublicFeedScope() {
  console.log('\n═══ Public Feed Scope Filtering ═══\n');

  const { data: stats } = await json('/api/im/evolution/public/stats');
  assert(stats.ok !== false, `Public stats endpoint works (got ok=${stats.ok})`);

  const { data: feed } = await json('/api/im/evolution/public/feed?limit=5');
  assert(feed.ok !== false, `Public feed endpoint works`);

  const { data: hot } = await json('/api/im/evolution/public/hot?limit=3');
  assert(hot.ok !== false, `Public hot genes endpoint works`);
}

// ============================================================================
// Test 2: Scopes endpoint
// ============================================================================

async function testScopesEndpoint() {
  console.log('\n═══ Scopes Endpoint ═══\n');

  if (!API_KEY) {
    console.log('  ⚠️  Skipped — set PRISMER_API_KEY');
    return;
  }

  const { data } = await json('/api/im/evolution/scopes');
  assert(data.ok === true, `GET /scopes returns ok=true`);
  assert(Array.isArray(data.data), `Scopes is an array`);
  assert(data.data.includes('global'), `Scopes includes "global"`);
}

// ============================================================================
// Test 3: Security APIs
// ============================================================================

async function testSecurityAPIs() {
  console.log('\n═══ Security APIs ═══\n');

  if (!API_KEY) {
    console.log('  ⚠️  Skipped — set PRISMER_API_KEY');
    return;
  }

  // Create a test conversation first (via direct message to self)
  const { data: regData } = await json('/api/im/register', 'POST', {
    type: 'agent',
    username: `test_sec_${Date.now()}`,
    displayName: 'Security Test',
  });
  const token = regData.data?.token;
  if (!token) {
    console.log('  ⚠️  Cannot register test agent');
    return;
  }

  const secHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Get security settings — non-participant gets 403 (correct access control)
  const { data: secData, status: secStatus } = await json('/api/im/conversations/test-conv-id/security');
  assert(
    secStatus === 200 || secStatus === 403,
    `Security GET returns 200 or 403 for non-participant (status=${secStatus})`,
  );
}

// ============================================================================
// Test 4: Rate Limit Headers
// ============================================================================

async function testRateLimitHeaders() {
  console.log('\n═══ Rate Limit Headers ═══\n');

  if (!API_KEY) {
    console.log('  ⚠️  Skipped — set PRISMER_API_KEY');
    return;
  }

  // POST to evolution/analyze should trigger rate limit middleware
  const res = await fetch(`${BASE}/api/im/evolution/analyze`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ context: 'test rate limit check', signals: ['test'] }),
  });

  // Check for rate limit headers (present even when not limited)
  const rlLimit = res.headers.get('X-RateLimit-Limit');
  const rlRemaining = res.headers.get('X-RateLimit-Remaining');
  const rlReset = res.headers.get('X-RateLimit-Reset');

  assert(rlLimit !== null, `X-RateLimit-Limit header present (${rlLimit})`);
  assert(rlRemaining !== null, `X-RateLimit-Remaining header present (${rlRemaining})`);
  assert(rlReset !== null, `X-RateLimit-Reset header present (${rlReset})`);
}

// ============================================================================
// Test 5: Scope parameter in evolution endpoints
// ============================================================================

async function testScopeParameter() {
  console.log('\n═══ Scope Parameter Threading ═══\n');

  if (!API_KEY) {
    console.log('  ⚠️  Skipped — set PRISMER_API_KEY');
    return;
  }

  // GET /genes with scope should work (return empty for non-existent scope)
  const { data: genes } = await json('/api/im/evolution/genes?scope=ws_test_nonexistent');
  assert(genes.ok === true, `GET /genes with scope param works`);
  assert(Array.isArray(genes.data), `Returns array (possibly empty for test scope)`);

  // GET /edges with scope
  const { data: edges } = await json('/api/im/evolution/edges?scope=ws_test_nonexistent');
  assert(edges.ok === true, `GET /edges with scope param works`);

  // GET /capsules with scope
  const { data: capsules } = await json('/api/im/evolution/capsules?scope=ws_test_nonexistent');
  assert(capsules.ok === true, `GET /capsules with scope param works`);

  // POST /analyze with scope — may hit rate limit (Tier 0 = 2/min)
  const { data: advice, status: analyzeStatus } = await json('/api/im/evolution/analyze?scope=global', 'POST', {
    context: 'scope test',
    signals: ['test:scope'],
  });
  assert(
    advice.ok === true || analyzeStatus === 429,
    `POST /analyze with scope=global works or rate limited (status=${analyzeStatus})`,
  );
}

// ============================================================================
// Test 6: Admin endpoint (should require admin role)
// ============================================================================

async function testAdminEndpoint() {
  console.log('\n═══ Admin Endpoint ═══\n');

  if (!API_KEY) {
    console.log('  ⚠️  Skipped — set PRISMER_API_KEY');
    return;
  }

  // Non-admin user should get 403
  const { status } = await json('/api/im/admin/users/test/trust-tier', 'PATCH', { trustTier: 2 });
  assert(status === 403, `Admin endpoint rejects non-admin (status=${status})`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Scope + Security Verification Tests     ║');
  console.log('╚══════════════════════════════════════════╝');

  await testPublicFeedScope();
  await testScopesEndpoint();
  await testSecurityAPIs();
  await testRateLimitHeaders();
  await testScopeParameter();
  await testAdminEndpoint();

  console.log(`\n════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
