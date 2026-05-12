/**
 * Prismer IM — PATCH /api/im/me username rename tests (Task 1 of naming-system overhaul)
 *
 * Verifies that the human-rename surface on PATCH /me:
 *   - accepts a valid username and reflects it back in the response
 *   - rejects malformed slugs with 400 + format error message
 *   - returns 409 "Username already taken" on collision (P2002)
 *   - still works for partial updates that omit username
 *   - still rejects an empty body with 400 "No editable fields provided"
 *
 * Runs against a standalone IM server at IM_BASE_URL (default
 * http://localhost:3200).
 *
 * Usage:
 *   1. mkdir -p prisma/data && DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
 *   2. DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts
 *   3. npx tsx src/im/tests/me-username.test.ts
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
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

interface ApiCall {
  status: number;
  data: any;
}

async function api(method: string, path: string, body?: unknown, token?: string): Promise<ApiCall> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, data: parsed };
}

interface CreatedUser {
  id: string;
  token: string;
  username: string;
}

async function createUser(suffix: string): Promise<CreatedUser> {
  // Initial username must satisfy the same slug regex; use only [a-z0-9-]
  // and start with a letter. TS is digits only, so prefix with a letter.
  const username = `meu-${TS}-${suffix}`.toLowerCase();
  const res = await api('POST', '/users/register', {
    username,
    displayName: `Me Username Test ${suffix}`,
    role: 'human',
    password: 'test123',
  });
  if (!res.data?.ok) throw new Error(`createUser failed: ${JSON.stringify(res.data)}`);
  return { id: res.data.data.user.id, token: res.data.data.token, username };
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   PATCH /api/im/me — username rename tests       ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`Server: ${BASE}\n`);

  // Sanity: server is up
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(
      `❌ IM server not reachable at ${BASE}. Start it first:\n   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts`,
    );
    process.exit(2);
  }

  // ── Test 1: happy path — valid username ──────────────────────
  console.log('🔹 Happy path — valid rename');
  await test('PATCH /me { username: "newname-…" } → 200 with new username', async () => {
    const u = await createUser('hap');
    const newName = `renamed-${TS}-h`.toLowerCase();
    const res = await api('PATCH', '/me', { username: newName }, u.token);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert(res.data?.ok === true, `ok flag missing: ${JSON.stringify(res.data)}`);
    assert(
      res.data?.data?.user?.username === newName,
      `expected username=${newName}, got ${res.data?.data?.user?.username}`,
    );
  });

  // ── Test 2: invalid format — uppercase letter ────────────────
  console.log('\n🔹 Validation — format');
  await test('PATCH /me { username: "Uppercase" } → 400 with format error', async () => {
    const u = await createUser('upr');
    const res = await api('PATCH', '/me', { username: 'Uppercase' }, u.token);
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert(res.data?.ok === false, `ok flag should be false: ${JSON.stringify(res.data)}`);
    assert(
      typeof res.data?.error === 'string' && /username/i.test(res.data.error),
      `error should describe username constraint, got: ${JSON.stringify(res.data)}`,
    );
  });

  await test('PATCH /me { username: "ab" } (too short) → 400', async () => {
    const u = await createUser('shr');
    const res = await api('PATCH', '/me', { username: 'ab' }, u.token);
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert(res.data?.ok === false, `ok flag should be false: ${JSON.stringify(res.data)}`);
  });

  await test('PATCH /me { username: "1starts-with-digit" } → 400', async () => {
    const u = await createUser('dig');
    const res = await api('PATCH', '/me', { username: '1bad' }, u.token);
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.data)}`);
  });

  // ── Test 3: collision — 409 ──────────────────────────────────
  console.log('\n🔹 Uniqueness — 409 Username already taken');
  await test('PATCH /me with a username taken by another user → 409', async () => {
    const owner = await createUser('own');
    const other = await createUser('oth');
    const res = await api('PATCH', '/me', { username: owner.username }, other.token);
    assert(res.status === 409, `expected 409, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert(
      res.data?.error === 'Username already taken',
      `expected exact 'Username already taken', got: ${JSON.stringify(res.data)}`,
    );
  });

  // ── Test 4: backwards compat — other fields still work alone ─
  console.log('\n🔹 Backwards compatibility');
  await test('PATCH /me { displayName: "..." } alone → 200 (no username sent)', async () => {
    const u = await createUser('dn');
    const res = await api('PATCH', '/me', { displayName: 'New Display Name' }, u.token);
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert(
      res.data?.data?.user?.displayName === 'New Display Name',
      `displayName not updated: ${JSON.stringify(res.data)}`,
    );
    // username should be the original — unchanged
    assert(
      res.data?.data?.user?.username === u.username,
      `username should be unchanged, got ${res.data?.data?.user?.username}`,
    );
  });

  // ── Test 5: empty body — 400 ─────────────────────────────────
  console.log('\n🔹 Empty body guard');
  await test('PATCH /me {} → 400 "No editable fields provided"', async () => {
    const u = await createUser('emp');
    const res = await api('PATCH', '/me', {}, u.token);
    assert(res.status === 400, `expected 400, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert(
      res.data?.error === 'No editable fields provided',
      `expected exact 'No editable fields provided', got: ${JSON.stringify(res.data)}`,
    );
  });

  // ── Summary ─────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────');
  console.log(`✅ ${passed} passed   ❌ ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(2);
});
