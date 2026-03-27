/**
 * Prismer IM — Sync & Offline-First Integration Tests
 *
 * Tests: sync events, cursor-based pagination, idempotency deduplication.
 *
 * Prerequisites:
 *   - IM server running: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts
 *
 * Usage: npx tsx src/im/tests/sync-offline.test.ts
 */

const BASE = process.env.IM_BASE_URL || 'http://localhost:3200';
const TS = String(Date.now()).slice(-8);

// ─── Test Infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: unknown, expected: unknown, field: string) {
  if (actual !== expected) {
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; data: any }> {
  const hdrs: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };
  if (token) {
    hdrs['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: hdrs,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { ok: res.ok };
  }
  return { status: res.status, data };
}

// ─── Test State ─────────────────────────────────────────────
let userAToken: string;
let userAId: string;
let userBToken: string;
let userBId: string;
let conversationId: string;
let initialCursor = 0;

// ─── Tests ──────────────────────────────────────────────────
async function main() {
  console.log('🧪 Prismer IM — Sync & Offline-First Integration Tests');
  console.log(`   Base URL: ${BASE}\n`);

  // ── Phase 1: Setup ──────────────────────────────────────
  console.log('🔹 Setup');

  await test('Register user A', async () => {
    const res = await api('POST', '/register', {
      type: 'human',
      username: `sync_a_${TS}`,
      displayName: `Sync Test A ${TS}`,
    });
    assert(res.data.ok === true, `Registration failed: ${JSON.stringify(res.data)}`);
    userAToken = res.data.data.token;
    userAId = res.data.data.imUserId;
    console.log(`    → userA: ${userAId}`);
  });

  await test('Register user B', async () => {
    const res = await api('POST', '/register', {
      type: 'human',
      username: `sync_b_${TS}`,
      displayName: `Sync Test B ${TS}`,
    });
    assert(res.data.ok === true, `Registration failed: ${JSON.stringify(res.data)}`);
    userBToken = res.data.data.token;
    userBId = res.data.data.imUserId;
    console.log(`    → userB: ${userBId}`);
  });

  await test('Create direct conversation (A → B)', async () => {
    const res = await api(
      'POST',
      `/direct/${userBId}/messages`,
      { content: 'Hello from A to B' },
      userAToken,
    );
    assert(res.data.ok === true, `Send failed: ${JSON.stringify(res.data)}`);
    conversationId = res.data.data.conversationId || res.data.data.message?.conversationId;
    assert(!!conversationId, 'No conversationId returned');
    console.log(`    → conversationId: ${conversationId}`);
  });

  // ── Phase 2: Sync Events ──────────────────────────────────
  console.log('\n🔹 Sync Events');

  await test('GET /sync returns events for user A', async () => {
    // Small delay for sync event write
    await new Promise(r => setTimeout(r, 300));

    const res = await api('GET', '/sync?since=0&limit=100', undefined, userAToken);
    assert(res.data.ok === true, `Sync failed: ${JSON.stringify(res.data)}`);
    const sync = res.data.data;
    assert(Array.isArray(sync.events), 'events should be array');
    assert(typeof sync.cursor === 'number', 'cursor should be number');
    assert(typeof sync.hasMore === 'boolean', 'hasMore should be boolean');

    // Should have at least 1 event (the message.new from setup)
    assert(sync.events.length >= 1, `Expected ≥1 events, got ${sync.events.length}`);
    console.log(`    → ${sync.events.length} events, cursor: ${sync.cursor}`);

    // Find the message.new event
    const newMsgEvent = sync.events.find((e: any) => e.type === 'message.new');
    assert(!!newMsgEvent, 'No message.new event found');
    assertEqual(newMsgEvent.conversationId, conversationId, 'event.conversationId');
    assert(typeof newMsgEvent.seq === 'number', 'seq should be number');
    assert(typeof newMsgEvent.at === 'string', 'at should be string');

    initialCursor = sync.cursor;
  });

  await test('GET /sync returns events for user B too', async () => {
    const res = await api('GET', '/sync?since=0&limit=100', undefined, userBToken);
    assert(res.data.ok === true, `Sync failed: ${JSON.stringify(res.data)}`);
    const sync = res.data.data;
    // B is a participant, should see the same events
    assert(sync.events.length >= 1, `Expected ≥1 events for user B, got ${sync.events.length}`);
  });

  await test('Cursor-based pagination: no new events after cursor', async () => {
    const res = await api('GET', `/sync?since=${initialCursor}&limit=100`, undefined, userAToken);
    assert(res.data.ok === true, `Sync failed: ${JSON.stringify(res.data)}`);
    assertEqual(res.data.data.events.length, 0, 'events after cursor');
    assertEqual(res.data.data.hasMore, false, 'hasMore');
    assertEqual(res.data.data.cursor, initialCursor, 'cursor unchanged');
  });

  // Send more messages and verify incremental sync
  await test('Send 3 more messages → creates 3 sync events', async () => {
    await api('POST', `/messages/${conversationId}`, { content: 'Msg 2 from A' }, userAToken);
    await api('POST', `/messages/${conversationId}`, { content: 'Msg 3 from B' }, userBToken);
    await api('POST', `/messages/${conversationId}`, { content: 'Msg 4 from A' }, userAToken);

    // Small delay
    await new Promise(r => setTimeout(r, 300));

    const res = await api('GET', `/sync?since=${initialCursor}&limit=100`, undefined, userAToken);
    assert(res.data.ok === true, `Sync failed: ${JSON.stringify(res.data)}`);
    const sync = res.data.data;
    assertEqual(sync.events.length, 3, 'new events count');
    assert(sync.cursor > initialCursor, 'cursor should advance');

    // Events should be ordered by seq
    assert(sync.events[0].seq < sync.events[1].seq, 'events should be ordered asc');
    assert(sync.events[1].seq < sync.events[2].seq, 'events should be ordered asc (2)');
  });

  await test('Pagination: limit=1 returns hasMore=true', async () => {
    const res = await api('GET', `/sync?since=${initialCursor}&limit=1`, undefined, userAToken);
    assert(res.data.ok === true, `Sync failed: ${JSON.stringify(res.data)}`);
    assertEqual(res.data.data.events.length, 1, 'limited events');
    assertEqual(res.data.data.hasMore, true, 'hasMore with limit');
  });

  // ── Phase 3: Idempotency ──────────────────────────────────
  console.log('\n🔹 Idempotency');

  let idemMessageId: string;
  const idemKey = `idem-${TS}-${Math.random().toString(36).slice(2, 8)}`;

  await test('Send message with idempotency key', async () => {
    const res = await api(
      'POST',
      `/messages/${conversationId}`,
      {
        content: 'Idempotent message',
        metadata: { _idempotencyKey: idemKey },
      },
      userAToken,
    );
    assert(res.data.ok === true, `Send failed: ${JSON.stringify(res.data)}`);
    idemMessageId = res.data.data.message?.id || res.data.data.id;
    assert(!!idemMessageId, 'No message id returned');
    console.log(`    → messageId: ${idemMessageId}`);
  });

  await test('Re-send same idempotency key → returns same message (deduped)', async () => {
    const res = await api(
      'POST',
      `/messages/${conversationId}`,
      {
        content: 'Idempotent message (retry)',
        metadata: { _idempotencyKey: idemKey },
      },
      userAToken,
    );
    assert(res.data.ok === true, `Re-send failed: ${JSON.stringify(res.data)}`);
    const retryId = res.data.data.message?.id || res.data.data.id;
    assertEqual(retryId, idemMessageId, 'message id should match (idempotent)');
  });

  await test('X-Idempotency-Key header also works', async () => {
    const headerKey = `idem-hdr-${TS}`;
    const res1 = await api(
      'POST',
      `/messages/${conversationId}`,
      { content: 'Header idempotency' },
      userAToken,
      { 'X-Idempotency-Key': headerKey },
    );
    assert(res1.data.ok === true, `First send failed: ${JSON.stringify(res1.data)}`);
    const firstId = res1.data.data.message?.id || res1.data.data.id;

    const res2 = await api(
      'POST',
      `/messages/${conversationId}`,
      { content: 'Header idempotency retry' },
      userAToken,
      { 'X-Idempotency-Key': headerKey },
    );
    assert(res2.data.ok === true, `Retry send failed: ${JSON.stringify(res2.data)}`);
    const retryId = res2.data.data.message?.id || res2.data.data.id;
    assertEqual(retryId, firstId, 'header idempotency should dedup');
  });

  await test('Different idempotency key → creates new message', async () => {
    const differentKey = `idem-diff-${TS}`;
    const res = await api(
      'POST',
      `/messages/${conversationId}`,
      {
        content: 'Idempotent message',
        metadata: { _idempotencyKey: differentKey },
      },
      userAToken,
    );
    assert(res.data.ok === true, `Send failed: ${JSON.stringify(res.data)}`);
    const newId = res.data.data.message?.id || res.data.data.id;
    assert(newId !== idemMessageId, 'different key should create different message');
  });

  // ── Phase 4: Sync events for edits and deletes ────────────
  console.log('\n🔹 Sync Events for Edits & Deletes');

  let editableMessageId: string;

  await test('Send a message to edit later', async () => {
    const res = await api(
      'POST',
      `/messages/${conversationId}`,
      { content: 'Original content' },
      userAToken,
    );
    assert(res.data.ok === true, `Send failed: ${JSON.stringify(res.data)}`);
    editableMessageId = res.data.data.message?.id || res.data.data.id;
  });

  // Get cursor before edit
  let cursorBeforeEdit: number;
  await test('Record cursor before edit', async () => {
    await new Promise(r => setTimeout(r, 200));
    const res = await api('GET', '/sync?since=0&limit=500', undefined, userAToken);
    cursorBeforeEdit = res.data.data.cursor;
  });

  await test('Edit message → generates message.edit sync event', async () => {
    const res = await api(
      'PATCH',
      `/messages/${conversationId}/${editableMessageId}`,
      { content: 'Edited content' },
      userAToken,
    );
    assert(res.data.ok === true, `Edit failed: ${JSON.stringify(res.data)}`);

    await new Promise(r => setTimeout(r, 300));

    const syncRes = await api('GET', `/sync?since=${cursorBeforeEdit}&limit=100`, undefined, userAToken);
    assert(syncRes.data.ok === true, `Sync failed: ${JSON.stringify(syncRes.data)}`);
    const editEvent = syncRes.data.data.events.find((e: any) => e.type === 'message.edit');
    assert(!!editEvent, 'No message.edit event found');
    assertEqual(editEvent.data.id, editableMessageId, 'edit event message id');
    assertEqual(editEvent.data.content, 'Edited content', 'edit event content');
  });

  await test('Delete message → generates message.delete sync event', async () => {
    // Send another message to delete
    const sendRes = await api(
      'POST',
      `/messages/${conversationId}`,
      { content: 'To be deleted' },
      userAToken,
    );
    const delId = sendRes.data.data.message?.id || sendRes.data.data.id;

    await new Promise(r => setTimeout(r, 200));
    const preDelSync = await api('GET', '/sync?since=0&limit=500', undefined, userAToken);
    const cursorBeforeDel = preDelSync.data.data.cursor;

    await api('DELETE', `/messages/${conversationId}/${delId}`, undefined, userAToken);
    await new Promise(r => setTimeout(r, 300));

    const syncRes = await api('GET', `/sync?since=${cursorBeforeDel}&limit=100`, undefined, userAToken);
    assert(syncRes.data.ok === true, `Sync failed: ${JSON.stringify(syncRes.data)}`);
    const delEvent = syncRes.data.data.events.find((e: any) => e.type === 'message.delete');
    assert(!!delEvent, 'No message.delete event found');
    assertEqual(delEvent.data.id, delId, 'delete event message id');
  });

  // ── Phase 5: Access control ───────────────────────────────
  console.log('\n🔹 Access Control');

  await test('Non-participant cannot see sync events from private conversation', async () => {
    // Register a third user who is NOT in the conversation
    const res = await api('POST', '/register', {
      type: 'human',
      username: `sync_c_${TS}`,
      displayName: `Sync Test C ${TS}`,
    });
    assert(res.data.ok === true, 'Register user C failed');
    const userCToken = res.data.data.token;

    const syncRes = await api('GET', '/sync?since=0&limit=500', undefined, userCToken);
    assert(syncRes.data.ok === true, `Sync failed: ${JSON.stringify(syncRes.data)}`);
    // User C should NOT see events from A-B conversation
    const foreignEvents = syncRes.data.data.events.filter(
      (e: any) => e.conversationId === conversationId
    );
    assertEqual(foreignEvents.length, 0, 'non-participant should see 0 events');
  });

  await test('Unauthenticated sync request returns 401', async () => {
    const res = await api('GET', '/sync?since=0');
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // ─── Results ────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\n❌ Failures:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
