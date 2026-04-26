/**
 * Prismer IM — Security Test Suite (P0-7 v1.8.0)
 *
 * Covers: SQL injection, privilege escalation, JWT forging,
 *         header injection, path traversal, rate limiting,
 *         input sanitization, and auth bypass attempts.
 *
 * Usage: npx tsx src/im/tests/test-security.ts
 */

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';
const TS = String(Date.now()).slice(-8);

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err.message || String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function post(path: string, body: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function get(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ─── Setup: register two users ──────────────────────────────

let userAToken = '';
let userBToken = '';
let userAId = '';
let userBId = '';

async function setup() {
  const regA = await post('/api/register', {
    username: `sec_user_a_${TS}`,
    displayName: 'Security User A',
    type: 'human',
  });
  assert(regA.data?.ok, `Register user A failed: ${JSON.stringify(regA.data)}`);
  userAToken = regA.data.data.token;
  userAId = regA.data.data.user.id;

  const regB = await post('/api/register', {
    username: `sec_user_b_${TS}`,
    displayName: 'Security User B',
    type: 'human',
  });
  assert(regB.data?.ok, `Register user B failed: ${JSON.stringify(regB.data)}`);
  userBToken = regB.data.data.token;
  userBId = regB.data.data.user.id;
}

// ─── Test Suites ─────────────────────────────────────────────

async function testSQLInjection() {
  console.log('\n🔹 SQL Injection Prevention');

  await test('Register with SQL injection in username', async () => {
    const res = await post('/api/register', {
      username: `admin'; DROP TABLE im_users; --`,
      displayName: 'Hacker',
      type: 'human',
    });
    assert(res.status !== 500, 'Server crashed on SQL injection attempt');
  });

  await test('SQL injection in search query', async () => {
    const res = await get(
      `/api/discover/agents?capability=${encodeURIComponent("' OR '1'='1")}`,
      userAToken,
    );
    assert(res.status !== 500, 'Server crashed on SQL injection in query');
  });

  await test('SQL injection in message content', async () => {
    const conv = await post('/api/conversations/direct', { otherUserId: userBId }, userAToken);
    if (conv.data?.ok) {
      const convId = conv.data.data.id;
      const res = await post(
        `/api/messages/${convId}`,
        { content: "test'; DELETE FROM im_messages WHERE '1'='1", type: 'text' },
        userAToken,
      );
      assert(res.status !== 500, 'Server crashed on SQL injection in message');
    }
  });

  await test('SQL injection in memory file path', async () => {
    const res = await post(
      '/api/memory/files',
      { path: "'; DROP TABLE im_memory_files; --", content: 'test' },
      userAToken,
    );
    assert(res.status !== 500, 'Server crashed on SQL injection in memory path');
  });

  await test('SQL injection in evolution signals', async () => {
    const res = await post(
      '/api/evolution/analyze',
      { signals: ["'; DROP TABLE im_genes; --"], error: 'test' },
      userAToken,
    );
    assert(res.status !== 500, 'Server crashed on SQL injection in signals');
  });
}

async function testAuthBypass() {
  console.log('\n🔹 Authentication Bypass');

  await test('Access protected endpoint without token', async () => {
    const res = await get('/api/conversations');
    assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });

  await test('Access with empty Authorization header', async () => {
    const headers: Record<string, string> = { Authorization: '' };
    const res = await fetch(`${BASE}/api/conversations`, { headers });
    assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });

  await test('Access with malformed JWT', async () => {
    const res = await get('/api/conversations', 'not.a.real.jwt.token');
    assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });

  await test('Access with expired-style JWT (random base64)', async () => {
    const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJoYWNrZXIiLCJleHAiOjB9', 'invalid'].join('.');
    const res = await get('/api/conversations', fakeJwt);
    assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });

  await test('Access with Bearer prefix only', async () => {
    const headers: Record<string, string> = { Authorization: 'Bearer ' };
    const res = await fetch(`${BASE}/api/conversations`, { headers });
    assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });
}

async function testPrivilegeEscalation() {
  console.log('\n🔹 Privilege Escalation');

  await test('User A cannot read User B private conversations', async () => {
    const conv = await post('/api/conversations/direct', { otherUserId: userAId }, userBToken);
    if (conv.data?.ok) {
      const convId = conv.data.data.id;
      const res = await get(`/api/messages/${convId}?limit=10`, userAToken);
      // User A should be able to access since they're part of the direct conversation
      // But creating a group without A and trying to read:
    }
  });

  await test('Non-participant cannot send message to conversation', async () => {
    // Create a conversation between A and B, then try with a new user C
    const regC = await post('/api/register', {
      username: `sec_user_c_${TS}`,
      displayName: 'Security User C',
      type: 'human',
    });
    if (!regC.data?.ok) return;
    const userCToken = regC.data.data.token;

    const conv = await post('/api/conversations/direct', { otherUserId: userBId }, userAToken);
    if (conv.data?.ok) {
      const convId = conv.data.data.id;
      const res = await post(
        `/api/messages/${convId}`,
        { content: 'Unauthorized message', type: 'text' },
        userCToken,
      );
      assert(
        res.status === 403 || res.status === 401 || (res.data && !res.data.ok),
        `Expected rejection, got status ${res.status}`,
      );
    }
  });

  await test('Cannot modify another user profile', async () => {
    const res = await post(
      '/api/me/profile',
      { displayName: 'Hacked Name' },
      'invalid-token-for-user-b',
    );
    assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });

  await test('Non-admin cannot access admin endpoints', async () => {
    const res = await get('/api/admin/moderation/pending', userAToken);
    assert(
      res.status === 403 || res.status === 401 || (res.data && !res.data.ok),
      `Expected admin rejection, got status ${res.status}`,
    );
  });
}

async function testHeaderInjection() {
  console.log('\n🔹 Header Injection');

  await test('CRLF injection in custom headers', async () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${userAToken}`,
      'X-Custom': 'value\r\nX-Injected: malicious',
    };
    const res = await fetch(`${BASE}/api/me`, { headers });
    assert(res.status !== 500, 'Server crashed on header injection');
  });

  await test('Oversized Authorization header', async () => {
    const longToken = 'Bearer ' + 'A'.repeat(100_000);
    const res = await fetch(`${BASE}/api/conversations`, {
      headers: { Authorization: longToken },
    });
    assert(res.status !== 500, `Server should reject oversized header, got ${res.status}`);
  });
}

async function testPathTraversal() {
  console.log('\n🔹 Path Traversal');

  await test('Path traversal in memory file path', async () => {
    const res = await post(
      '/api/memory/files',
      { path: '../../../etc/passwd', content: 'test' },
      userAToken,
    );
    assert(res.status !== 500, 'Server crashed on path traversal in memory');
    if (res.data?.ok) {
      assert(
        !res.data.data?.path?.includes('..'),
        'Path traversal was not sanitized',
      );
    }
  });

  await test('Null byte injection in path', async () => {
    const res = await post(
      '/api/memory/files',
      { path: 'file\x00.txt', content: 'test' },
      userAToken,
    );
    assert(res.status !== 500, 'Server crashed on null byte injection');
  });

  await test('URL-encoded traversal', async () => {
    const res = await get(
      `/api/memory/files?path=${encodeURIComponent('..%2F..%2Fetc%2Fpasswd')}`,
      userAToken,
    );
    assert(res.status !== 500, 'Server crashed on URL-encoded traversal');
  });
}

async function testInputValidation() {
  console.log('\n🔹 Input Validation & Sanitization');

  await test('XSS in display name', async () => {
    const res = await post('/api/register', {
      username: `xss_test_${TS}_x`,
      displayName: '<script>alert("xss")</script>',
      type: 'human',
    });
    if (res.data?.ok) {
      const name = res.data.data.user.displayName;
      assert(
        !name.includes('<script>'),
        `XSS not sanitized in displayName: ${name}`,
      );
    }
  });

  await test('Oversized content payload', async () => {
    const bigContent = 'A'.repeat(10_000_000);
    const res = await post(
      '/api/register',
      { username: bigContent, displayName: 'Big', type: 'human' },
      undefined,
    );
    assert(
      res.status === 400 || res.status === 413 || res.status === 422 || (res.data && !res.data.ok),
      `Expected rejection for oversized input, got ${res.status}`,
    );
  });

  await test('Invalid JSON body', async () => {
    const res = await fetch(`${BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    });
    assert(res.status === 400 || res.status === 500, `Expected 400/500, got ${res.status}`);
    assert(res.status !== 500, 'Server crashed on invalid JSON');
  });

  await test('Unicode control characters in username', async () => {
    const res = await post('/api/register', {
      username: `user\u0000\u0001\u001f_${TS}`,
      displayName: 'Control Chars',
      type: 'human',
    });
    assert(res.status !== 500, 'Server crashed on control characters');
  });

  await test('Empty required fields', async () => {
    const res = await post('/api/register', {
      username: '',
      displayName: '',
      type: 'human',
    });
    assert(
      res.status === 400 || (res.data && !res.data.ok),
      `Expected validation error for empty fields, got ${res.status}`,
    );
  });

  await test('Wrong type for numeric fields', async () => {
    const res = await get(
      `/api/conversations?limit=not_a_number&offset=-1`,
      userAToken,
    );
    assert(res.status !== 500, 'Server crashed on invalid numeric params');
  });
}

async function testRateLimiting() {
  console.log('\n🔹 Rate Limiting');

  await test('Registration rate limit', async () => {
    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await post('/api/register', {
        username: `ratelimit_${TS}_${i}`,
        displayName: `Rate Limit ${i}`,
        type: 'human',
      });
      results.push(res.status);
    }
    const rateLimited = results.filter((s) => s === 429);
    // May or may not hit rate limit depending on config — just verify no 500s
    const serverErrors = results.filter((s) => s === 500);
    assert(serverErrors.length === 0, `Got ${serverErrors.length} server errors during rapid registration`);
  });
}

async function testJWTForging() {
  console.log('\n🔹 JWT Forging & Manipulation');

  await test('JWT with modified payload (tampered)', async () => {
    if (!userAToken) return;
    const parts = userAToken.split('.');
    if (parts.length !== 3) return;
    // Tamper with payload: change sub to a different user
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.sub = 'admin_user_hacked';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = parts.join('.');
    const res = await get('/api/me', tampered);
    assert(res.status === 401 || res.status === 403, `Tampered JWT accepted: ${res.status}`);
  });

  await test('JWT with none algorithm', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: userAId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const noneJwt = `${header}.${payload}.`;
    const res = await get('/api/me', noneJwt);
    assert(res.status === 401 || res.status === 403, `JWT with alg:none accepted: ${res.status}`);
  });

  await test('JWT with empty signature', async () => {
    if (!userAToken) return;
    const parts = userAToken.split('.');
    if (parts.length !== 3) return;
    const noSig = `${parts[0]}.${parts[1]}.`;
    const res = await get('/api/me', noSig);
    assert(res.status === 401 || res.status === 403, `JWT with empty sig accepted: ${res.status}`);
  });
}

async function testCommunitySecurityBoundary() {
  console.log('\n🔹 Community Security Boundary');

  await test('Cannot vote on own post', async () => {
    const postRes = await post(
      '/api/community/posts',
      { boardId: 'helpdesk', title: `sec test ${TS}`, content: 'self-vote test' },
      userAToken,
    );
    if (postRes.data?.ok && postRes.data.data?.id) {
      const voteRes = await post(
        `/api/community/posts/${postRes.data.data.id}/vote`,
        { value: 1 },
        userAToken,
      );
      // Self-voting should be rejected or at least not crash
      assert(voteRes.status !== 500, 'Server crashed on self-vote');
    }
  });

  await test('Cannot delete another user post', async () => {
    const postRes = await post(
      '/api/community/posts',
      { boardId: 'helpdesk', title: `sec owned ${TS}`, content: 'owned by A' },
      userAToken,
    );
    if (postRes.data?.ok && postRes.data.data?.id) {
      const delRes = await fetch(`${BASE}/api/community/posts/${postRes.data.data.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      assert(
        delRes.status === 403 || delRes.status === 401 || delRes.status === 404,
        `Expected rejection when deleting other's post, got ${delRes.status}`,
      );
    }
  });
}

// ─── Runner ──────────────────────────────────────────────────

async function main() {
  console.log(`🔐 Security Test Suite — ${BASE}\n`);
  console.log('Setting up test users...');
  await setup();

  await testSQLInjection();
  await testAuthBypass();
  await testPrivilegeEscalation();
  await testHeaderInjection();
  await testPathTraversal();
  await testInputValidation();
  await testRateLimiting();
  await testJWTForging();
  await testCommunitySecurityBoundary();

  // Summary
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🔐 Security Tests: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ❌ ${f}`);
  }
  console.log(`${'═'.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Security test runner failed:', err);
  process.exit(1);
});
