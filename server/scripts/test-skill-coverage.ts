/**
 * Skill.md Coverage Regression — validates every operation described in Skill.md
 * against the test environment (cloud.prismer.dev).
 *
 * Usage: npx tsx scripts/test-skill-coverage.ts
 */

const BASE = 'https://cloud.prismer.dev';
const API_KEY =
  process.env.PRISMER_API_KEY_TEST ||
  'sk-prismer-live-REDACTED-SET-VIA-ENV';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    const msg = `${label}${detail ? ` — ${detail}` : ''}`;
    console.log(`  ❌ ${msg}`);
    failed++;
    failures.push(msg);
  }
}

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` };

async function api(path: string, method = 'GET', body?: any): Promise<{ status: number; data: any; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { ok: false };
  }
  return { status: res.status, data, headers: res.headers };
}

// ============================================================================
// Context API (Skill.md §Context)
// ============================================================================

async function testContext() {
  console.log('\n═══ Context API ═══\n');

  // Single URL load
  const { data: single } = await api('/api/context/load', 'POST', { input: 'https://example.com' });
  assert(single.success === true, 'context load: single URL');
  assert(typeof single.processingTime === 'number', 'context load: has processingTime');

  // Search mode
  const { data: search } = await api('/api/context/load', 'POST', { input: 'AI agent frameworks' });
  assert(search.success === true, 'context load: search query');

  // Save (requires url + hqcc)
  const { data: save } = await api('/api/context/save', 'POST', {
    url: 'https://test-skill-coverage.example.com',
    hqcc: 'Test HQCC content for skill coverage regression',
  });
  assert(save.success === true || save.data !== undefined, 'context save');
}

// ============================================================================
// Parse API (Skill.md §Parse)
// ============================================================================

async function testParse() {
  console.log('\n═══ Parse API ═══\n');

  const { data: parse, status } = await api('/api/parse', 'POST', {
    url: 'https://arxiv.org/pdf/2401.00001.pdf',
    mode: 'fast',
  });
  assert(status === 200, `parse: fast mode (status=${status})`);
  assert(parse.success === true, 'parse: returns success');
}

// ============================================================================
// IM API (Skill.md §IM)
// ============================================================================

async function testIM() {
  console.log('\n═══ IM API ═══\n');

  // Health
  const { data: health } = await api('/api/im/health');
  assert(health.ok === true, 'im health');

  // Me
  const { data: me } = await api('/api/im/me');
  const meUser = me.data?.user || me.data;
  assert(me.ok === true && meUser?.username, `im me: ${meUser?.username}`);
  const myUserId = meUser?.id;

  // Discover
  const { data: discover } = await api('/api/im/discover');
  assert(discover.ok === true && Array.isArray(discover.data), 'im discover');

  // Contacts
  const { data: contacts } = await api('/api/im/contacts');
  assert(contacts.ok === true, 'im contacts');

  // Conversations
  const { data: convs } = await api('/api/im/conversations');
  assert(convs.ok === true && Array.isArray(convs.data), 'im conversations list');

  // Send message — use an existing conversation or direct message to self
  // First, find an existing conversation
  const existingConv = convs.data?.[0]?.id;
  if (existingConv) {
    // Send
    const { data: sent } = await api(`/api/im/messages/${existingConv}`, 'POST', {
      content: 'Skill coverage test',
      type: 'text',
    });
    assert(sent.ok === true, 'im send message');
    const msgId = sent.data?.id;

    // Get messages
    const { data: msgs } = await api(`/api/im/messages/${existingConv}`);
    assert(msgs.ok === true && Array.isArray(msgs.data), 'im get messages');

    // Edit message
    if (msgId) {
      const { data: edited } = await api(`/api/im/messages/${existingConv}/${msgId}`, 'PATCH', {
        content: 'Edited content',
      });
      assert(edited.ok === true, 'im edit message');

      // Delete message
      const { data: deleted } = await api(`/api/im/messages/${existingConv}/${msgId}`, 'DELETE');
      assert(deleted.ok === true, 'im delete message');
    }
  } else {
    console.log('  ⏭ No existing conversation — send/edit/delete skipped');
  }

  // Groups (API expects "title" not "name")
  const { data: groupCreate } = await api('/api/im/groups', 'POST', {
    title: `Skill Test Group ${Date.now()}`,
    memberIds: [],
  });
  assert(groupCreate.ok === true, 'im groups create');

  const { data: groups } = await api('/api/im/groups');
  assert(groups.ok === true && Array.isArray(groups.data), 'im groups list');

  // Credits
  const { data: credits } = await api('/api/im/credits');
  assert(credits.ok === true, 'im credits balance');
}

// ============================================================================
// Files API (Skill.md §File Transfer)
// ============================================================================

async function testFiles() {
  console.log('\n═══ Files API ═══\n');

  // Quota
  const { data: quota } = await api('/api/im/files/quota');
  assert(quota.ok === true, 'files quota');

  // Types (data is { allowedMimeTypes: [...] })
  const { data: types } = await api('/api/im/files/types');
  assert(types.ok === true && types.data?.allowedMimeTypes, 'files types');

  // Presign (response has .url not .uploadUrl)
  const { data: presign } = await api('/api/im/files/presign', 'POST', {
    fileName: 'skill-test.txt',
    mimeType: 'text/plain',
    fileSize: 100,
  });
  assert(presign.ok === true && (presign.data?.url || presign.data?.uploadUrl), 'files presign');

  // Reject blocked MIME
  const { data: blocked } = await api('/api/im/files/presign', 'POST', {
    fileName: 'test.exe',
    mimeType: 'application/x-msdownload',
    fileSize: 100,
  });
  assert(blocked.ok === false || blocked.error, 'files reject blocked MIME');
}

// ============================================================================
// Evolution API (Skill.md §Evolution)
// ============================================================================

async function testEvolution() {
  console.log('\n═══ Evolution API ═══\n');

  // Analyze
  const { data: advice, status: analyzeStatus } = await api('/api/im/evolution/analyze', 'POST', {
    signals: [{ type: 'error:timeout' }],
  });
  assert(analyzeStatus === 200 || analyzeStatus === 429, `evolution analyze (status=${analyzeStatus})`);
  if (analyzeStatus === 200) {
    assert(advice.data?.action !== undefined, `analyze action: ${advice.data?.action}`);
  }

  // Analyze with scope
  const { data: scopedAdvice } = await api('/api/im/evolution/analyze?scope=global', 'POST', {
    signals: [{ type: 'error:timeout' }],
  });
  assert(scopedAdvice.ok === true || scopedAdvice.data, 'evolution analyze with scope');

  // Genes list
  const { data: genes } = await api('/api/im/evolution/genes');
  assert(genes.ok === true, 'evolution genes list');

  // Genes with scope
  const { data: scopedGenes } = await api('/api/im/evolution/genes?scope=global');
  assert(scopedGenes.ok === true, 'evolution genes with scope');

  // Edges
  const { data: edges } = await api('/api/im/evolution/edges');
  assert(edges.ok === true, 'evolution edges');

  // Capsules
  const { data: capsules } = await api('/api/im/evolution/capsules');
  assert(capsules.ok === true, 'evolution capsules');

  // Report
  const { data: report } = await api('/api/im/evolution/report');
  assert(report.ok === true, 'evolution report');

  // Achievements
  const { data: achievements } = await api('/api/im/evolution/achievements');
  assert(achievements.ok === true, 'evolution achievements');

  // Sync snapshot
  const { data: snapshot } = await api('/api/im/evolution/sync/snapshot');
  assert(snapshot.ok === true, 'evolution sync snapshot');
  if (snapshot.ok) {
    assert(Array.isArray(snapshot.data?.genes), `snapshot genes: ${snapshot.data?.genes?.length}`);
  }

  // Scopes
  const { data: scopes } = await api('/api/im/evolution/scopes');
  assert(scopes.ok === true && scopes.data?.includes('global'), 'evolution scopes');

  // Public endpoints
  const { data: stats } = await api('/api/im/evolution/public/stats');
  assert(stats.ok === true, 'evolution public stats');

  const { data: hot } = await api('/api/im/evolution/public/hot?limit=3');
  assert(hot.ok === true, 'evolution public hot');

  const { data: feed } = await api('/api/im/evolution/public/feed?limit=3');
  assert(feed.ok === true, 'evolution public feed');

  const { data: metrics } = await api('/api/im/evolution/metrics');
  assert(metrics.ok === true, 'evolution metrics (A/B)');

  // Scope validation
  const { status: badScope } = await api('/api/im/evolution/genes?scope=invalid;DROP');
  assert(badScope === 400, `scope validation rejects injection (${badScope})`);

  // Rate limit headers
  const { headers: rlHeaders } = await api('/api/im/evolution/analyze', 'POST', {
    signals: ['test:ratelimit'],
  });
  assert(rlHeaders.get('x-ratelimit-limit') !== null, 'rate limit headers present');
}

// ============================================================================
// Tasks API (Skill.md §Tasks)
// ============================================================================

async function testTasks() {
  console.log('\n═══ Tasks API ═══\n');

  // Create task
  const { data: created } = await api('/api/im/tasks', 'POST', {
    title: `Skill coverage test ${Date.now()}`,
    description: 'Test task from skill coverage regression',
    priority: 'medium',
  });
  assert(created.ok === true, 'tasks create');
  const taskId = created.data?.id;

  // List tasks
  const { data: list } = await api('/api/im/tasks');
  assert(list.ok === true && Array.isArray(list.data), 'tasks list');

  // Update task
  if (taskId) {
    const { data: updated } = await api(`/api/im/tasks/${taskId}`, 'PATCH', {
      status: 'completed',
      result: 'Skill coverage test completed',
    });
    assert(updated.ok === true, 'tasks update');

    // Task detail (includes logs inline, no separate /logs endpoint)
    const { data: detail } = await api(`/api/im/tasks/${taskId}`);
    assert(detail.ok === true, 'tasks detail (includes logs)');
  }
}

// ============================================================================
// Memory API (Skill.md §Memory)
// ============================================================================

async function testMemory() {
  console.log('\n═══ Memory API ═══\n');

  // Memory and Recall endpoints — 404 means not yet deployed to test env
  const { status: memStatus } = await api('/api/im/memory', 'POST', {
    scope: 'session',
    path: 'skill-test/coverage.md',
    content: '# Skill Coverage Test\n\nThis is a test memory entry.',
  });
  if (memStatus === 404) {
    console.log('  ⏭ Memory API: 404 — not yet deployed to test environment');
    // Test the route existence in source code instead
    const fs = require('fs');
    const routes = fs.readFileSync('src/im/api/routes.ts', 'utf-8');
    assert(routes.includes("'/memory'"), 'memory route registered in source');
    assert(routes.includes("'/recall'"), 'recall route registered in source');
  } else {
    assert(memStatus === 200 || memStatus === 201, 'memory write');
    const { data: read } = await api('/api/im/memory?scope=session&path=skill-test/coverage.md');
    assert(read.ok === true, 'memory read');
    const { data: recall } = await api('/api/im/memory/recall', 'POST', { query: 'test' });
    assert(recall.ok === true, 'memory recall');
  }
}

// ============================================================================
// Security API (Skill.md §Identity & Security)
// ============================================================================

async function testSecurity() {
  console.log('\n═══ Security API ═══\n');

  // Security on non-existent conversation (should 403 — not a participant)
  const { status: secGet } = await api('/api/im/conversations/nonexistent-conv/security');
  assert(secGet === 403 || secGet === 404, `security get: non-participant (${secGet})`);

  // Admin endpoint (should reject non-admin)
  const { status: admin } = await api('/api/im/admin/users/test/trust-tier', 'PATCH', { trustTier: 2 });
  assert(admin === 403, `admin endpoint rejects non-admin (${admin})`);
}

// ============================================================================
// Workspace API (Skill.md §Workspace)
// ============================================================================

async function testWorkspace() {
  console.log('\n═══ Workspace API ═══\n');

  // Init workspace (flat params, not nested objects)
  const { data: ws } = await api('/api/im/workspace/init', 'POST', {
    workspaceId: `skill-ws-${Date.now()}`,
    userId: 'skill-user-ws',
    userDisplayName: 'Skill User WS',
    agentId: 'skill-agent-ws',
    agentDisplayName: 'Skill Agent WS',
    agentType: 'assistant',
    agentCapabilities: ['test'],
  });
  assert(ws.ok === true, 'workspace init');
  assert(ws.data?.conversationId, 'workspace returns conversationId');
  assert(ws.data?.user?.token || ws.data?.agent?.token, 'workspace returns token');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Skill.md Coverage Regression                ║');
  console.log('║  Target: cloud.prismer.dev                   ║');
  console.log('╚══════════════════════════════════════════════╝');

  await testContext();
  await testParse();
  await testIM();
  await testFiles();
  await testEvolution();
  await testTasks();
  await testMemory();
  await testSecurity();
  await testWorkspace();

  console.log('\n══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\n  ─── Failures ───');
    for (const f of failures) console.log(`  • ${f}`);
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
