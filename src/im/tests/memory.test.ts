/**
 * Prismer IM — Memory Layer Tests
 *
 * Tests all Memory API endpoints:
 *   - Memory Files CRUD (POST, GET, GET:id, PATCH, DELETE)
 *   - Compaction (POST, GET)
 *   - Auto-load (GET /memory/load)
 *
 * Run: DATABASE_URL="file:$(pwd)/prisma/data/dev.db" npx tsx src/im/tests/memory.test.ts
 */

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3200';

let token = '';
let userId = '';
let memoryFileId = '';

let passed = 0;
let failed = 0;
const results: { name: string; ok: boolean; error?: string }[] = [];

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    results.push({ name, ok: false, error: err.message });
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

async function api(method: string, path: string, body?: any) {
  const url = BASE.includes('/api/im') ? `${BASE}${path.replace(/^\/api/, '')}` : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, ...json };
}

// ─── Setup: Register a test user ────────────────────────────

async function setup() {
  console.log('\n🔧 Setup: Register test user');
  const username = `memory-test-${Date.now()}`;
  const res = await api('POST', '/api/register', {
    type: 'agent',
    username,
    displayName: 'Memory Test Agent',
    agentType: 'assistant',
  });
  assert(res.ok, `Register failed: ${JSON.stringify(res)}`);
  token = res.data.token;
  userId = res.data.imUserId;
  console.log(`  User: ${userId} (${username})`);
}

// ─── Memory Files Tests ────────────────────────────────────

async function testMemoryFiles() {
  console.log('\n📝 Memory Files CRUD');

  await test('POST /memory/files — create MEMORY.md', async () => {
    const res = await api('POST', '/api/memory/files', {
      path: 'MEMORY.md',
      content: '# Agent Memory\n\n## Patterns\n- Pattern A\n- Pattern B\n',
      scope: 'global',
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.ok === true, 'Response not ok');
    assert(res.data.path === 'MEMORY.md', `Path mismatch: ${res.data.path}`);
    assert(res.data.version === 1, `Version should be 1, got ${res.data.version}`);
    assert(res.data.ownerId === userId, `Owner mismatch: ${res.data.ownerId}`);
    memoryFileId = res.data.id;
  });

  await test('POST /memory/files — create topic file', async () => {
    const res = await api('POST', '/api/memory/files', {
      path: 'debugging.md',
      content: '# Debugging Notes\n\n## Issue 1\nFixed via retry logic\n',
      scope: 'global',
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.data.path === 'debugging.md', `Path mismatch`);
  });

  await test('POST /memory/files — upsert existing file (same path)', async () => {
    const res = await api('POST', '/api/memory/files', {
      path: 'MEMORY.md',
      content: '# Agent Memory v2\n\nUpdated content\n',
      scope: 'global',
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.data.version === 2, `Version should be 2 after upsert, got ${res.data.version}`);
    assert(res.data.content.includes('v2'), 'Content not updated');
    memoryFileId = res.data.id; // Same ID
  });

  await test('GET /memory/files — list all files', async () => {
    const res = await api('GET', '/api/memory/files');
    assert(res.ok === true, 'Response not ok');
    assert(Array.isArray(res.data), 'Data should be array');
    assert(res.data.length === 2, `Expected 2 files, got ${res.data.length}`);
    // Should NOT have content field in list
    const hasContent = res.data.some((f: any) => f.content !== undefined);
    assert(!hasContent, 'List should not include content');
  });

  await test('GET /memory/files?scope=global&path=MEMORY.md — filter', async () => {
    const res = await api('GET', '/api/memory/files?scope=global&path=MEMORY.md');
    assert(res.ok === true, 'Response not ok');
    assert(res.data.length === 1, `Expected 1 file, got ${res.data.length}`);
    assert(res.data[0].path === 'MEMORY.md', 'Path filter failed');
  });

  await test('GET /memory/files/:id — read with content', async () => {
    const res = await api('GET', `/api/memory/files/${memoryFileId}`);
    assert(res.ok === true, 'Response not ok');
    assert(res.data.content !== undefined, 'Should include content');
    assert(res.data.content.includes('v2'), 'Content should be v2');
    assert(res.data.version === 2, `Version should be 2, got ${res.data.version}`);
  });

  await test('GET /memory/files/:id — not found', async () => {
    const res = await api('GET', '/api/memory/files/nonexistent-id-12345');
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test('PATCH /memory/files/:id — append', async () => {
    const res = await api('PATCH', `/api/memory/files/${memoryFileId}`, {
      operation: 'append',
      content: '\n## New Section\nAppended content\n',
      version: 2,
    });
    assert(res.ok === true, `Response not ok: ${res.error}`);
    assert(res.data.version === 3, `Version should be 3, got ${res.data.version}`);
    assert(res.data.content.includes('Appended content'), 'Appended content missing');
    assert(res.data.content.includes('v2'), 'Original content should be preserved');
  });

  await test('PATCH /memory/files/:id — replace', async () => {
    const res = await api('PATCH', `/api/memory/files/${memoryFileId}`, {
      operation: 'replace',
      content: '# Fresh Memory\n\n## Patterns\n- New pattern\n\n## Debugging\n- Old notes\n',
      version: 3,
    });
    assert(res.ok === true, `Response not ok: ${res.error}`);
    assert(res.data.version === 4, `Version should be 4, got ${res.data.version}`);
    assert(!res.data.content.includes('v2'), 'Old content should be replaced');
  });

  await test('PATCH /memory/files/:id — replace_section', async () => {
    const res = await api('PATCH', `/api/memory/files/${memoryFileId}`, {
      operation: 'replace_section',
      section: 'Debugging',
      content: '- Updated debug notes\n- Fix for issue #42\n',
      version: 4,
    });
    assert(res.ok === true, `Response not ok: ${res.error}`);
    assert(res.data.version === 5, `Version should be 5, got ${res.data.version}`);
    assert(res.data.content.includes('Fix for issue #42'), 'Section content not replaced');
    assert(res.data.content.includes('New pattern'), 'Other section should be preserved');
  });

  await test('PATCH /memory/files/:id — version conflict (409)', async () => {
    const res = await api('PATCH', `/api/memory/files/${memoryFileId}`, {
      operation: 'append',
      content: 'This should fail',
      version: 1, // Stale version
    });
    assert(res.status === 409, `Expected 409, got ${res.status}`);
    assert(res.error?.includes('conflict') || res.error?.includes('Version'), `Error: ${res.error}`);
  });

  await test('PATCH /memory/files/:id — invalid operation (400)', async () => {
    const res = await api('PATCH', `/api/memory/files/${memoryFileId}`, {
      operation: 'invalid_op',
      content: 'test',
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /memory/files — missing path (400)', async () => {
    const res = await api('POST', '/api/memory/files', {
      content: 'no path',
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /memory/files — with custom scope', async () => {
    const res = await api('POST', '/api/memory/files', {
      path: 'MEMORY.md',
      content: '# Workspace Memory\n',
      scope: 'workspace-123',
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.data.scope === 'workspace-123', `Scope mismatch: ${res.data.scope}`);
  });
}

// ─── Compaction Tests ──────────────────────────────────────

async function testCompaction() {
  console.log('\n🗜️ Compaction');

  // Create a real conversation so participant check passes
  const convRes = await api('POST', '/api/conversations/group', {
    title: 'Memory Compaction Test',
  });
  assert(convRes.ok, `Failed to create conversation: ${JSON.stringify(convRes)}`);
  const conversationId = convRes.data.id;

  await test('POST /memory/compact — create compaction summary', async () => {
    const res = await api('POST', '/api/memory/compact', {
      conversationId,
      summary: '## Goal\nBuild a REST API\n\n## Progress\n- Endpoints defined\n- Tests written\n\n## Key Information\n- Using Hono framework\n- Port 3200\n',
      messageRangeStart: 'msg-001',
      messageRangeEnd: 'msg-050',
    });
    assert(res.status === 201, `Expected 201, got ${res.status}: ${res.error}`);
    assert(res.ok === true, 'Response not ok');
    assert(res.data.conversationId === conversationId, 'Conversation ID mismatch');
    assert(res.data.tokenCount > 0, `Token count should be > 0, got ${res.data.tokenCount}`);
    assert(res.data.messageRangeStart === 'msg-001', 'Range start mismatch');
    assert(res.data.messageRangeEnd === 'msg-050', 'Range end mismatch');
  });

  await test('POST /memory/compact — second compaction', async () => {
    const res = await api('POST', '/api/memory/compact', {
      conversationId,
      summary: '## Goal\nBuild a REST API (continued)\n\n## Progress\n- All endpoints deployed\n- Integration tests pass\n',
    });
    assert(res.status === 201, `Expected 201, got ${res.status}: ${res.error}`);
  });

  await test('GET /memory/compact/:conversationId — list summaries', async () => {
    const res = await api('GET', `/api/memory/compact/${conversationId}`);
    assert(res.ok === true, `Response not ok: ${res.error}`);
    assert(Array.isArray(res.data), 'Data should be array');
    assert(res.data.length === 2, `Expected 2 summaries, got ${res.data.length}`);
    // Latest first
    assert(res.data[0].summary.includes('continued'), 'Latest should be first');
  });

  await test('POST /memory/compact — missing conversationId (400)', async () => {
    const res = await api('POST', '/api/memory/compact', {
      summary: 'no conversation',
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('POST /memory/compact — missing summary (400)', async () => {
    const res = await api('POST', '/api/memory/compact', {
      conversationId: 'some-conv',
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await test('GET /memory/compact — non-participant gets 403', async () => {
    // Use the other-user token from later in the test? No, just use a fake conv
    // The participant check returns 403 for non-participants
    const fakeConvId = 'nonexistent-conv-id-12345';
    const res = await api('GET', `/api/memory/compact/${fakeConvId}`);
    assert(res.status === 403, `Expected 403 for non-participant, got ${res.status}`);
  });
}

// ─── Auto-load Tests ───────────────────────────────────────

async function testAutoLoad() {
  console.log('\n📥 Auto-load Session Memory');

  await test('GET /memory/load — loads MEMORY.md with metadata', async () => {
    const res = await api('GET', '/api/memory/load');
    assert(res.ok === true, 'Response not ok');
    assert(res.data.path === 'MEMORY.md', 'Path should be MEMORY.md');
    assert(res.data.content !== null, 'Content should not be null');
    assert(res.data.totalLines > 0, `totalLines should be > 0, got ${res.data.totalLines}`);
    assert(res.data.totalBytes > 0, `totalBytes should be > 0, got ${res.data.totalBytes}`);
    assert(res.data.version > 0, `version should be > 0, got ${res.data.version}`);
    assert(res.data.id !== null, 'id should not be null');
    assert(res.data.template !== undefined, 'Should include compaction template');
  });

  await test('GET /memory/load?scope=nonexistent — null content', async () => {
    const res = await api('GET', '/api/memory/load?scope=does-not-exist');
    assert(res.ok === true, 'Response not ok');
    assert(res.data.content === null, `Content should be null for missing scope, got: ${typeof res.data.content}`);
    assert(res.data.totalLines === 0, 'totalLines should be 0 for missing');
  });

  await test('GET /memory/load — returns full content (no server-side truncation)', async () => {
    // Create a MEMORY.md with > 200 lines
    const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}: Important fact #${i + 1}`);
    const bigContent = lines.join('\n');

    const scope = `full-test-${Date.now()}`;
    await api('POST', '/api/memory/files', {
      path: 'MEMORY.md',
      content: bigContent,
      scope,
    });

    const res = await api('GET', `/api/memory/load?scope=${scope}`);
    assert(res.ok === true, 'Response not ok');
    assert(res.data.content !== null, 'Content should not be null');
    assert(res.data.totalLines === 250, `totalLines should be 250, got ${res.data.totalLines}`);
    assert(res.data.content.includes('Line 250'), 'Full content should include Line 250');
    assert(res.data.content.includes('Line 1'), 'Full content should include Line 1');
    assert(!res.data.content.includes('Truncated'), 'Should NOT have truncation notice');
  });
}

// ─── Delete Tests ──────────────────────────────────────────

async function testDelete() {
  console.log('\n🗑️ Delete');

  await test('DELETE /memory/files/:id — delete file', async () => {
    const res = await api('DELETE', `/api/memory/files/${memoryFileId}`);
    assert(res.ok === true, `Delete failed: ${res.error}`);
  });

  await test('DELETE /memory/files/:id — already deleted (404)', async () => {
    const res = await api('DELETE', `/api/memory/files/${memoryFileId}`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test('GET /memory/files/:id — deleted file not found', async () => {
    const res = await api('GET', `/api/memory/files/${memoryFileId}`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });
}

// ─── Ownership Tests ───────────────────────────────────────

async function testOwnership() {
  console.log('\n🔒 Ownership isolation');

  // Register a second user (clear token to avoid binding to first user)
  const savedToken = token;
  token = '';
  const username2 = `memory-other-${Date.now()}`;
  const reg = await api('POST', '/api/register', {
    type: 'agent',
    username: username2,
    displayName: 'Other Agent',
  });

  const otherToken = reg.data.token;
  token = savedToken;

  // Create a file as the first user
  const createRes = await api('POST', '/api/memory/files', {
    path: 'private.md',
    content: 'Secret notes',
    scope: 'global',
  });
  const privateId = createRes.data.id;

  // Try to read it as the second user
  token = otherToken;

  await test('GET /memory/files/:id — other user cannot read', async () => {
    const res = await api('GET', `/api/memory/files/${privateId}`);
    assert(res.status === 404, `Expected 404 for other user, got ${res.status}`);
  });

  await test('PATCH /memory/files/:id — other user cannot update', async () => {
    const res = await api('PATCH', `/api/memory/files/${privateId}`, {
      operation: 'append',
      content: 'Injected!',
    });
    assert(res.status === 404, `Expected 404 for other user, got ${res.status}`);
  });

  await test('DELETE /memory/files/:id — other user cannot delete', async () => {
    const res = await api('DELETE', `/api/memory/files/${privateId}`);
    assert(res.status === 404, `Expected 404 for other user, got ${res.status}`);
  });

  await test('GET /memory/files — other user sees 0 files', async () => {
    const res = await api('GET', '/api/memory/files');
    assert(res.ok === true, 'Response not ok');
    assert(res.data.length === 0, `Other user should see 0 files, got ${res.data.length}`);
  });

  token = savedToken;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Prismer IM — Memory Layer Tests');
  console.log(`  Server: ${BASE}`);
  console.log('═══════════════════════════════════════════════');

  await setup();
  await testMemoryFiles();
  await testCompaction();
  await testAutoLoad();
  await testDelete();
  await testOwnership();

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log('═══════════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  ❌ ${r.name}: ${r.error}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
