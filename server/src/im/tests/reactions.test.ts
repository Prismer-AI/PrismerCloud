/**
 * Prismer IM — Message Reactions Integration Tests (v1.8.2)
 *
 * Covers the POST /api/messages/:conversationId/:messageId/reactions endpoint
 * and the underlying im_message_reactions table.
 *
 * Key invariants verified:
 *   • Add is idempotent (composite unique key prevents duplicate rows)
 *   • Remove is idempotent (deleteMany is a no-op on 0 matches)
 *   • Concurrent adds do NOT produce duplicates (race safety — this is the
 *     regression test for the original metadata-JSON read-modify-write bug)
 *   • Non-participant is rejected with 403
 *   • Multiple users' reactions with the same emoji aggregate
 *
 * Run:
 *   # Ensure IM server is up on :3200 with a clean SQLite dev DB
 *   mkdir -p prisma/data && DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx prisma db push
 *   DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts &
 *   npx tsx src/im/tests/reactions.test.ts
 */

const IM_SERVER_URL = process.env.IM_SERVER_URL || 'http://localhost:3200';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`✅ ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    results.push({
      name,
      passed: false,
      error: (err as Error).message,
      duration: Date.now() - start,
    });
    console.log(`❌ ${name}: ${(err as Error).message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function api<T = any>(
  method: string,
  path: string,
  body?: any,
  token?: string,
): Promise<{ ok: boolean; data?: T; error?: string; status: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(`${IM_SERVER_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await resp.json().catch(() => ({ ok: false, error: 'invalid json' }));
  return { ...parsed, status: resp.status };
}

async function runTests() {
  console.log('=== Prismer IM Reactions Tests (v1.8.2) ===\n');
  console.log(`Server: ${IM_SERVER_URL}\n`);

  const testId = Date.now().toString(36);

  // Two participants + one outsider
  let aliceToken = '';
  let aliceId = '';
  let bobToken = '';
  let bobId = '';
  let outsiderToken = '';
  let conversationId = '';
  let messageId = '';

  await test('Setup: register alice, bob, outsider', async () => {
    for (const [key, name] of [
      ['alice', `alice_${testId}`],
      ['bob', `bob_${testId}`],
      ['outsider', `out_${testId}`],
    ] as const) {
      const resp = await api('POST', '/api/users/register', {
        username: name,
        displayName: name,
        role: 'human',
      });
      assert(resp.ok, `register ${key}: ${resp.error}`);
      if (key === 'alice') {
        aliceToken = resp.data.token;
        aliceId = resp.data.user.id;
      } else if (key === 'bob') {
        bobToken = resp.data.token;
        bobId = resp.data.user.id;
      } else {
        outsiderToken = resp.data.token;
      }
    }
    assert(!!aliceId && !!bobId, 'missing ids from register');
  });

  await test('Setup: alice creates group with bob, sends message', async () => {
    const conv = await api<any>(
      'POST',
      '/api/conversations/group',
      { title: `rxn_${testId}`, memberIds: [bobId] },
      aliceToken,
    );
    assert(conv.ok, `create conv: ${conv.error}`);
    conversationId = conv.data.id;

    const msg = await api<any>(
      'POST',
      `/api/messages/${conversationId}`,
      { content: 'hello', type: 'text' },
      aliceToken,
    );
    assert(msg.ok, `send msg: ${msg.error}`);
    messageId = msg.data.message?.id ?? msg.data.id;
    assert(!!messageId, 'no message id returned');
  });

  // ─── Core behavior ──────────────────────────────────────────────

  await test('Add reaction: alice 👍 → reactions contains one user', async () => {
    const resp = await api<any>(
      'POST',
      `/api/messages/${conversationId}/${messageId}/reactions`,
      { emoji: '👍' },
      aliceToken,
    );
    assert(resp.ok, `add: ${resp.error}`);
    const reactions = resp.data.reactions;
    assertEqual(reactions['👍']?.length, 1, 'one user reacted');
    assertEqual(reactions['👍'][0], aliceId, 'reactor is alice');
  });

  await test('Add reaction (idempotent): alice 👍 again → still one', async () => {
    const resp = await api<any>(
      'POST',
      `/api/messages/${conversationId}/${messageId}/reactions`,
      { emoji: '👍' },
      aliceToken,
    );
    assert(resp.ok, `add again: ${resp.error}`);
    assertEqual(resp.data.reactions['👍']?.length, 1, 'still one user');
  });

  await test('Add reaction: bob 👍 → aggregates to two users', async () => {
    const resp = await api<any>(
      'POST',
      `/api/messages/${conversationId}/${messageId}/reactions`,
      { emoji: '👍' },
      bobToken,
    );
    assert(resp.ok, `bob add: ${resp.error}`);
    const reactors = resp.data.reactions['👍'] as string[];
    assertEqual(reactors.length, 2, 'two users reacted');
    assert(reactors.includes(aliceId), 'alice still there');
    assert(reactors.includes(bobId), 'bob added');
  });

  // ─── Race safety — original bug regression ─────────────────────

  // NOTE: dev.db is SQLite which serializes writes at the file level, so this
  // run won't exercise a true MySQL row-lock race. The composite unique key on
  // im_message_reactions makes the upsert correct by construction either way;
  // for genuine MySQL concurrency coverage run this file with
  // DATABASE_URL=mysql://... against a v1.8.2+ schema.
  await test('Concurrent adds (race): bob 🎉 x5 in parallel → 1 entry', async () => {
    const parallel = Array.from({ length: 5 }, () =>
      api('POST', `/api/messages/${conversationId}/${messageId}/reactions`, { emoji: '🎉' }, bobToken),
    );
    const all = await Promise.all(parallel);
    assert(
      all.every((r) => r.ok),
      `some concurrent adds failed: ${all
        .filter((r) => !r.ok)
        .map((r) => r.error)
        .join(', ')}`,
    );
    // Re-fetch state via one more add (returns full snapshot)
    const snap = await api<any>(
      'POST',
      `/api/messages/${conversationId}/${messageId}/reactions`,
      { emoji: '🎉' },
      bobToken,
    );
    assertEqual(snap.data.reactions['🎉']?.length, 1, 'exactly one entry despite 5 parallel adds');
  });

  // ─── Remove ─────────────────────────────────────────────────────

  await test('Remove reaction: alice 👍 → bob remains', async () => {
    const resp = await api<any>(
      'POST',
      `/api/messages/${conversationId}/${messageId}/reactions`,
      { emoji: '👍', remove: true },
      aliceToken,
    );
    assert(resp.ok, `remove: ${resp.error}`);
    const reactors = resp.data.reactions['👍'] as string[];
    assertEqual(reactors.length, 1, 'bob remains');
    assertEqual(reactors[0], bobId, 'bob is the remaining reactor');
  });

  await test('Remove reaction (idempotent): alice 👍 again → no error', async () => {
    const resp = await api<any>(
      'POST',
      `/api/messages/${conversationId}/${messageId}/reactions`,
      { emoji: '👍', remove: true },
      aliceToken,
    );
    assert(resp.ok, `remove again: ${resp.error}`);
    assertEqual((resp.data.reactions['👍'] as string[])?.length, 1, 'still just bob');
  });

  // ─── Authorization ──────────────────────────────────────────────

  await test('Non-participant is rejected with 403', async () => {
    const resp = await api(
      'POST',
      `/api/messages/${conversationId}/${messageId}/reactions`,
      { emoji: '❤️' },
      outsiderToken,
    );
    assert(!resp.ok, 'outsider should have been rejected');
    assertEqual(resp.status, 403, 'expected 403');
  });

  // ─── Input validation ───────────────────────────────────────────

  await test('Missing emoji → 400', async () => {
    const resp = await api('POST', `/api/messages/${conversationId}/${messageId}/reactions`, {}, aliceToken);
    assert(!resp.ok, 'should have been rejected');
    assertEqual(resp.status, 400, 'expected 400');
  });

  await test('Oversized emoji (>32 chars) → 400', async () => {
    const resp = await api(
      'POST',
      `/api/messages/${conversationId}/${messageId}/reactions`,
      { emoji: 'x'.repeat(33) },
      aliceToken,
    );
    assert(!resp.ok, 'should have been rejected');
    assertEqual(resp.status, 400, 'expected 400');
  });

  // ─── Metadata size cap (related v1.8.2 hardening) ──────────────

  await test('Metadata >16KB on message send → 400 (related guard)', async () => {
    const huge = { waveform: Array(5000).fill(0.5), transcription: 'x'.repeat(10000) };
    const resp = await api(
      'POST',
      `/api/messages/${conversationId}`,
      { content: 'voice msg', type: 'voice', metadata: huge },
      aliceToken,
    );
    assert(!resp.ok, 'should have been rejected as too large');
    assert((resp.error || '').toLowerCase().includes('metadata'), `error should mention metadata; got: ${resp.error}`);
  });

  // ─── Summary ────────────────────────────────────────────────────

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('\nFailures:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
