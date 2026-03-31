/**
 * Prismer IM — Conversation Sync Events & SSE Stream Tests
 *
 * Verifies Phase 1A (conversation sync events) and Phase 1B (SSE stream).
 *
 * Prerequisites:
 *   - IM server running: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/start.ts
 *
 * Usage: npx tsx src/im/tests/conversation-sync.test.ts
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

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: any }> {
  const hdrs: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) hdrs['Authorization'] = `Bearer ${token}`;

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
let userCToken: string;
let userCId: string;
let cursorBefore = 0;

// ─── Tests ──────────────────────────────────────────────────
async function main() {
  console.log('🧪 Prismer IM — Conversation Sync Events & SSE Stream Tests');
  console.log(`   Base URL: ${BASE}\n`);

  // ── Setup: Register 3 users ────────────────────────────────
  console.log('🔹 Setup');

  await test('Register user A', async () => {
    const res = await api('POST', '/register', {
      type: 'human',
      username: `csync_a_${TS}`,
      displayName: `ConvSync A ${TS}`,
    });
    assert(res.data.ok === true, `Registration failed: ${JSON.stringify(res.data)}`);
    userAToken = res.data.data.token;
    userAId = res.data.data.imUserId;
    console.log(`    → userA: ${userAId}`);
  });

  await test('Register user B', async () => {
    const res = await api('POST', '/register', {
      type: 'human',
      username: `csync_b_${TS}`,
      displayName: `ConvSync B ${TS}`,
    });
    assert(res.data.ok === true, `Registration failed: ${JSON.stringify(res.data)}`);
    userBToken = res.data.data.token;
    userBId = res.data.data.imUserId;
    console.log(`    → userB: ${userBId}`);
  });

  await test('Register user C', async () => {
    const res = await api('POST', '/register', {
      type: 'human',
      username: `csync_c_${TS}`,
      displayName: `ConvSync C ${TS}`,
    });
    assert(res.data.ok === true, `Registration failed: ${JSON.stringify(res.data)}`);
    userCToken = res.data.data.token;
    userCId = res.data.data.imUserId;
    console.log(`    → userC: ${userCId}`);
  });

  // Capture cursor before conversation operations
  await test('Capture initial sync cursor for user A', async () => {
    const res = await api('GET', '/sync?limit=1', undefined, userAToken);
    assert(res.data.ok === true, `Sync failed: ${JSON.stringify(res.data)}`);
    cursorBefore = res.data.data.cursor;
    console.log(`    → cursor: ${cursorBefore}`);
  });

  // ── Phase 1A: Conversation Sync Events ─────────────────────
  console.log('\n🔹 Phase 1A: Conversation Sync Events');

  let directConvId: string;
  await test('Create direct conversation → sync event fires', async () => {
    const res = await api('POST', `/direct/${userBId}/messages`, {
      content: `Direct sync test ${TS}`,
    }, userAToken);
    assert(res.data.ok === true, `Send DM failed: ${JSON.stringify(res.data)}`);
    directConvId = res.data.data.conversationId;
    console.log(`    → directConvId: ${directConvId}`);

    // Check sync events for user A
    const syncA = await api('GET', `/sync?since=${cursorBefore}&limit=50`, undefined, userAToken);
    assert(syncA.data.ok === true, `Sync A failed`);
    const convCreateA = syncA.data.data.events.find(
      (e: any) => e.type === 'conversation.create' && e.data?.id === directConvId
    );
    assert(!!convCreateA, 'User A should see conversation.create sync event');
    assert(convCreateA.data.type === 'direct', 'Should be type "direct"');
    console.log(`    → User A sees conversation.create (seq=${convCreateA.seq})`);

    // Check sync events for user B
    const syncB = await api('GET', `/sync?since=${cursorBefore}&limit=50`, undefined, userBToken);
    assert(syncB.data.ok === true, `Sync B failed`);
    const convCreateB = syncB.data.data.events.find(
      (e: any) => e.type === 'conversation.create' && e.data?.id === directConvId
    );
    assert(!!convCreateB, 'User B should also see conversation.create sync event');
    console.log(`    → User B sees conversation.create (seq=${convCreateB.seq})`);
  });

  let groupConvId: string;
  await test('Create group → conversation.create sync event for all members', async () => {
    const res = await api('POST', '/groups', {
      title: `SyncGroup_${TS}`,
      members: [userBId, userCId],
    }, userAToken);
    assert(res.data.ok === true, `Create group failed: ${JSON.stringify(res.data)}`);
    groupConvId = res.data.data.groupId;
    console.log(`    → groupConvId: ${groupConvId}`);

    // All 3 users should see the event
    for (const [label, token] of [['A', userAToken], ['B', userBToken], ['C', userCToken]] as const) {
      const sync = await api('GET', `/sync?since=${cursorBefore}&limit=100`, undefined, token);
      assert(sync.data.ok === true, `Sync ${label} failed`);
      const ev = sync.data.data.events.find(
        (e: any) => e.type === 'conversation.create' && e.data?.id === groupConvId
      );
      assert(!!ev, `User ${label} should see conversation.create for group`);
      assert(ev.data.type === 'group', 'Should be type "group"');
      console.log(`    → User ${label} sees conversation.create (seq=${ev.seq})`);
    }
  });

  await test('Add participant (user C to direct) → participant.add sync event', async () => {
    // Use the conversations API to add participant
    const res = await api('POST', `/conversations/${directConvId}/participants`, {
      userId: userCId,
      role: 'member',
    }, userAToken);
    // Might be 200 or 201
    assert(res.status < 300, `Add participant failed: ${JSON.stringify(res.data)}`);

    // All 3 users (A, B, C) should see participant.add
    for (const [label, token] of [['A', userAToken], ['B', userBToken], ['C', userCToken]] as const) {
      const sync = await api('GET', `/sync?since=${cursorBefore}&limit=100`, undefined, token);
      assert(sync.data.ok === true, `Sync ${label} failed`);
      const ev = sync.data.data.events.find(
        (e: any) => e.type === 'participant.add' && e.data?.conversationId === directConvId && e.data?.userId === userCId
      );
      assert(!!ev, `User ${label} should see participant.add event`);
      console.log(`    → User ${label} sees participant.add (seq=${ev.seq})`);
    }
  });

  await test('Remove participant → participant.remove sync event (removed user sees it too)', async () => {
    const res = await api('DELETE', `/conversations/${directConvId}/participants/${userCId}`, undefined, userAToken);
    assert(res.status < 300, `Remove participant failed: ${JSON.stringify(res.data)}`);

    // User C should still see the remove event (written BEFORE removal)
    const syncC = await api('GET', `/sync?since=${cursorBefore}&limit=100`, undefined, userCToken);
    assert(syncC.data.ok === true, 'Sync C failed');
    const ev = syncC.data.data.events.find(
      (e: any) => e.type === 'participant.remove' && e.data?.conversationId === directConvId && e.data?.userId === userCId
    );
    assert(!!ev, 'Removed user C should see participant.remove event');
    console.log(`    → User C sees participant.remove (seq=${ev.seq})`);

    // User A should also see it
    const syncA = await api('GET', `/sync?since=${cursorBefore}&limit=100`, undefined, userAToken);
    const evA = syncA.data.data.events.find(
      (e: any) => e.type === 'participant.remove' && e.data?.conversationId === directConvId
    );
    assert(!!evA, 'User A should see participant.remove event');
    console.log(`    → User A sees participant.remove (seq=${evA.seq})`);
  });

  await test('Update group title → conversation.update sync event', async () => {
    const res = await api('PATCH', `/conversations/${groupConvId}`, {
      title: `Updated_${TS}`,
    }, userAToken);
    assert(res.status < 300, `Update failed: ${JSON.stringify(res.data)}`);

    // User B should see the update
    const syncB = await api('GET', `/sync?since=${cursorBefore}&limit=100`, undefined, userBToken);
    assert(syncB.data.ok === true, 'Sync B failed');
    const ev = syncB.data.data.events.find(
      (e: any) => e.type === 'conversation.update' && e.data?.id === groupConvId
    );
    assert(!!ev, 'User B should see conversation.update event');
    assert(ev.data.title === `Updated_${TS}`, 'Title should match');
    console.log(`    → User B sees conversation.update (seq=${ev.seq})`);
  });

  await test('Archive conversation → conversation.archive sync event', async () => {
    const res = await api('POST', `/conversations/${groupConvId}/archive`, undefined, userAToken);
    assert(res.status < 300, `Archive failed: ${JSON.stringify(res.data)}`);

    // User C should see the archive
    const syncC = await api('GET', `/sync?since=${cursorBefore}&limit=100`, undefined, userCToken);
    assert(syncC.data.ok === true, 'Sync C failed');
    const ev = syncC.data.data.events.find(
      (e: any) => e.type === 'conversation.archive' && e.data?.id === groupConvId
    );
    assert(!!ev, 'User C should see conversation.archive event');
    console.log(`    → User C sees conversation.archive (seq=${ev.seq})`);
  });

  // ── Phase 1B: SSE Sync Stream ─────────────────────────────
  console.log('\n🔹 Phase 1B: SSE Sync Stream Endpoint');

  await test('SSE /sync/stream — catch-up and caught_up marker', async () => {
    // Connect with cursor 0 to get all events
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${BASE}/api/sync/stream?token=${userAToken}&since=${cursorBefore}`, {
        signal: controller.signal,
        headers: { 'Accept': 'text/event-stream' },
      });
      assert(res.status === 200, `SSE status should be 200, got ${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      assert(contentType.includes('text/event-stream'), `Content-Type should be text/event-stream, got ${contentType}`);

      // Read events from stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events: { event: string; data: string }[] = [];

      while (events.length < 20) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!; // Keep incomplete part
        for (const part of parts) {
          if (!part.trim()) continue;
          let event = 'message';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          events.push({ event, data });
          // Stop after we see caught_up
          if (event === 'caught_up') break;
        }
        if (events.some(e => e.event === 'caught_up')) break;
      }

      controller.abort();

      // Should have at least some sync events + caught_up
      const syncEvents = events.filter(e => e.event === 'sync');
      const caughtUp = events.find(e => e.event === 'caught_up');
      assert(syncEvents.length > 0, `Should have sync events, got ${syncEvents.length}`);
      assert(!!caughtUp, 'Should have caught_up marker');
      console.log(`    → Received ${syncEvents.length} sync events + caught_up`);

      // Verify sync events are parseable JSON
      for (const se of syncEvents) {
        const parsed = JSON.parse(se.data);
        assert(!!parsed.type, 'Sync event should have type');
        assert(!!parsed.seq, 'Sync event should have seq');
      }
      console.log(`    → All sync events are valid JSON with type+seq`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('SSE connection timed out (5s) without receiving caught_up');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  });

  await test('SSE /sync/stream — auth required', async () => {
    const res = await fetch(`${BASE}/api/sync/stream`);
    assert(res.status === 401, `Should require auth, got ${res.status}`);
  });

  await test('SSE /sync/stream — invalid token rejected', async () => {
    const res = await fetch(`${BASE}/api/sync/stream?token=invalid.jwt.token`);
    assert(res.status === 401, `Should reject invalid token, got ${res.status}`);
  });

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

  if (failures.length > 0) {
    console.log('\n❌ Failures:');
    failures.forEach(f => console.log(`   - ${f}`));
    process.exit(1);
  }

  console.log('✅ All conversation sync & SSE tests passed!');
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
