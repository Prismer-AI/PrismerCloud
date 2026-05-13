/**
 * v1.8.2 Wire-Layer Targeted Regression (test env: cloud.prismer.dev)
 *
 * Focus: the 4 things this release changed that could silently break:
 *   1. Reactions endpoint + im_message_reactions table (migration 038)
 *   2. New MessageType additions (voice, location, artifact, system)
 *   3. 16KB metadata cap enforced on send
 *   4. WS dedicated message.reaction event name (NOT message.edit)
 *
 * Uses:
 *   - PRISMER_API_KEY_TEST for caller A identity (maps to an existing IM agent)
 *   - /api/im/register to create a fresh caller B (token-authed)
 *
 * Run:
 *   npx tsx scripts/regression-v182-reactions.ts
 */

const BASE = process.env.PRISMER_BASE_URL || 'https://cloud.prismer.dev';
const API_KEY =
  process.env.PRISMER_API_KEY_TEST ||
  'sk-prismer-live-REDACTED-SET-VIA-ENV';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  ms: number;
}
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, ms: Date.now() - start });
    console.log(`✅ ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    results.push({ name, passed: false, error: (err as Error).message, ms: Date.now() - start });
    console.log(`❌ ${name}: ${(err as Error).message}`);
  }
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};
const assertEq = <T>(a: T, b: T, msg: string) => {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

async function api<T = any>(
  method: string,
  path: string,
  body: any,
  auth: string,
): Promise<{ ok: boolean; data?: T; error?: string; status: number }> {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await resp.json().catch(() => ({ ok: false, error: 'non-JSON response' }));
  return { ...parsed, status: resp.status };
}

async function run() {
  console.log(`=== v1.8.2 Reactions Regression — ${BASE} ===\n`);

  // --- Version sanity ---
  const ver = await fetch(`${BASE}/api/version`).then((r) => r.json());
  console.log(`Target: v${ver.version} (build ${ver.buildDate})\n`);

  let aliceId = '';
  let aliceToken = API_KEY; // API key acts as auth for caller A
  let bobId = '';
  let bobToken = '';
  let conversationId = '';
  let textMsgId = '';

  // --- Identity setup ---
  await test('API key resolves to an IM user (caller A)', async () => {
    const me = await api<any>('GET', '/api/im/me', null, aliceToken);
    assert(me.ok, `me: ${me.error}`);
    aliceId = me.data.user.id;
    assert(!!aliceId, 'no alice imUserId');
  });

  await test('Register fresh IM user for caller B (resolve id via /me)', async () => {
    const u = await api<any>(
      'POST',
      '/api/im/register',
      {
        username: `rxn-b-${Date.now().toString(36)}`,
        displayName: 'Rxn Test B',
        type: 'agent',
        agentType: 'assistant',
      },
      aliceToken,
    );
    assert(u.ok, `register B: ${u.error}`);
    bobToken = u.data.token;
    // NOTE: register response's `imUserId` field holds the username on cloud,
    // not the DB id. `/api/im/me` is the authoritative source for JWT → id.
    const me = await api<any>('GET', '/api/im/me', null, bobToken);
    assert(me.ok, `bob /me: ${me.error}`);
    bobId = me.data.user.id;
    assert(!!bobId && !!bobToken, 'missing B identity');
  });

  await test('Alice creates a fresh group with Bob', async () => {
    const c = await api<any>(
      'POST',
      '/api/im/conversations/group',
      {
        title: `rxn-regress-${Date.now().toString(36)}`,
        memberIds: [bobId],
      },
      aliceToken,
    );
    assert(c.ok, `create group: ${c.error}`);
    conversationId = c.data.id;
  });

  // --- NEW MessageType: voice / location / artifact / system ---
  await test('v1.8.2 NEW type: send voice message with duration/waveform', async () => {
    const m = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}`,
      {
        content: 'voice-note.m4a',
        type: 'voice',
        metadata: { duration: 12, fileUrl: 'https://example.com/a.m4a', waveform: [0.1, 0.3, 0.7, 0.3, 0.1] },
      },
      aliceToken,
    );
    assert(m.ok, `send voice: ${m.error}`);
    const msg = m.data.message ?? m.data;
    assertEq(msg.type, 'voice', 'type round-trip');
  });

  await test('v1.8.2 NEW type: send location', async () => {
    const m = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}`,
      {
        content: '37.7749,-122.4194',
        type: 'location',
        metadata: { latitude: 37.7749, longitude: -122.4194, locationName: 'SF' },
      },
      aliceToken,
    );
    assert(m.ok, `send location: ${m.error}`);
  });

  await test('v1.8.2 NEW type: send artifact with artifactType=pdf', async () => {
    const m = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}`,
      {
        content: 'report.pdf',
        type: 'artifact',
        metadata: { title: 'Q1 Report', artifactType: 'pdf', pageCount: 24 },
      },
      aliceToken,
    );
    assert(m.ok, `send artifact: ${m.error}`);
  });

  await test('v1.8.2 NEW type: send system notification (member_join)', async () => {
    const m = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}`,
      {
        content: 'Bob joined',
        type: 'system',
        metadata: { action: 'member_join', userId: bobId, userName: 'Bob' },
      },
      aliceToken,
    );
    assert(m.ok, `send system: ${m.error}`);
  });

  // Record a plain text message as the reaction target
  await test('Send text message (reaction target)', async () => {
    const m = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}`,
      {
        content: 'react to me',
        type: 'text',
      },
      aliceToken,
    );
    assert(m.ok, `send text: ${m.error}`);
    textMsgId = (m.data.message ?? m.data).id;
    assert(!!textMsgId, 'no message id');
  });

  // --- Reactions endpoint ---
  await test('Reactions: alice adds 👍 → reactions has 1 user', async () => {
    const r = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}/${textMsgId}/reactions`,
      { emoji: '👍' },
      aliceToken,
    );
    assert(r.ok, `add: ${r.error}`);
    assertEq(r.data.reactions['👍']?.length, 1, 'one reactor');
    assertEq(r.data.reactions['👍'][0], aliceId, 'is alice');
  });

  await test('Reactions: alice 👍 again (idempotent) → still 1', async () => {
    const r = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}/${textMsgId}/reactions`,
      { emoji: '👍' },
      aliceToken,
    );
    assert(r.ok, `add dup: ${r.error}`);
    assertEq(r.data.reactions['👍']?.length, 1, 'still 1 after dup');
  });

  await test('Reactions: bob adds 👍 → aggregates to 2', async () => {
    const r = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}/${textMsgId}/reactions`,
      { emoji: '👍' },
      bobToken,
    );
    assert(r.ok, `bob add: ${r.error}`);
    const list = r.data.reactions['👍'] as string[];
    assertEq(list.length, 2, 'two reactors');
    assert(list.includes(aliceId) && list.includes(bobId), 'both present');
  });

  await test('Reactions: 5 concurrent bob 🎉 → exactly 1 entry (MySQL row-lock regression)', async () => {
    const all = await Promise.all(
      Array.from({ length: 5 }, () =>
        api('POST', `/api/im/messages/${conversationId}/${textMsgId}/reactions`, { emoji: '🎉' }, bobToken),
      ),
    );
    const failed = all.filter((r: any) => !r.ok);
    assert(failed.length === 0, `failures: ${failed.map((r: any) => r.error).join(', ')}`);
    const snap = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}/${textMsgId}/reactions`,
      { emoji: '🎉' },
      bobToken,
    );
    assertEq(snap.data.reactions['🎉']?.length, 1, 'exactly 1 entry on MySQL');
  });

  await test('Reactions: alice removes 👍 → bob remains', async () => {
    const r = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}/${textMsgId}/reactions`,
      { emoji: '👍', remove: true },
      aliceToken,
    );
    assert(r.ok, `remove: ${r.error}`);
    const list = r.data.reactions['👍'] as string[];
    assertEq(list.length, 1, 'bob remains');
    assertEq(list[0], bobId, 'bob is the survivor');
  });

  await test('Reactions: alice removes 👍 again (idempotent) → no error', async () => {
    const r = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}/${textMsgId}/reactions`,
      { emoji: '👍', remove: true },
      aliceToken,
    );
    assert(r.ok, `remove dup: ${r.error}`);
  });

  // --- Input guards ---
  await test('Reactions: missing emoji → 400', async () => {
    const r = await api('POST', `/api/im/messages/${conversationId}/${textMsgId}/reactions`, {}, aliceToken);
    assertEq(r.status, 400, 'expect 400');
  });

  await test('Reactions: oversized emoji (>32 chars) → 400', async () => {
    const r = await api(
      'POST',
      `/api/im/messages/${conversationId}/${textMsgId}/reactions`,
      { emoji: 'x'.repeat(33) },
      aliceToken,
    );
    assertEq(r.status, 400, 'expect 400');
  });

  // --- Metadata size cap ---
  await test('Metadata >16KB on send → 400 with "metadata" in error', async () => {
    const huge = { waveform: Array(5000).fill(0.5), transcription: 'x'.repeat(10000) };
    const r = await api(
      'POST',
      `/api/im/messages/${conversationId}`,
      {
        content: 'voice-huge',
        type: 'voice',
        metadata: huge,
      },
      aliceToken,
    );
    assert(!r.ok, 'should be rejected');
    assert((r.error || '').toLowerCase().includes('metadata'), `error should mention metadata; got: ${r.error}`);
  });

  // --- Legacy regression: plain text still works untouched ---
  await test('Regression: plain text send + read still OK', async () => {
    const m = await api<any>(
      'POST',
      `/api/im/messages/${conversationId}`,
      {
        content: 'post-reaction smoke',
        type: 'text',
      },
      aliceToken,
    );
    assert(m.ok, `post-reaction text: ${m.error}`);
    const list = await api<any>('GET', `/api/im/messages/${conversationId}?limit=5`, null, aliceToken);
    assert(list.ok && Array.isArray(list.data) && list.data.length > 0, 'list failed');
  });

  // --- Summary ---
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed, ${failed} failed ===`);
  if (failed) {
    console.log('\nFailures:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('Runner crashed:', e);
  process.exit(2);
});
