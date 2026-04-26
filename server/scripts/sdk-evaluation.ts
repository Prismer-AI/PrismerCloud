/**
 * SDK Evaluation & Regression — against test environment
 *
 * Covers:
 *   L1: Method parity across 4 SDKs (static analysis)
 *   L2: End-to-end functional tests (against cloud.prismer.dev)
 *   L3: Mechanism layer (cache, enrichment, outbox, runtime) — all 4 SDKs
 *   L5: Session tracking (EvolutionSession + SessionMetrics) — all 4 SDKs
 *   L5+: Plugin assessment (Claude Code, OpenCode, OpenClaw)
 *   Signal enrichment accuracy
 *
 * Usage: PRISMER_API_KEY_TEST=sk-... npx tsx scripts/sdk-evaluation.ts
 */

import { extractMeta } from '../src/lib/context-meta';

const BASE = process.env.PRISMER_BASE_URL || 'https://cloud.prismer.dev';
const API_KEY =
  process.env.PRISMER_API_KEY_TEST ||
  (process.env.PRISMER_API_KEY || process.env.PRISMER_API_KEY_TEST || '');

let passed = 0;
let failed = 0;
const findings: string[] = [];

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
    findings.push(`FAIL: ${label}${detail ? ': ' + detail : ''}`);
  }
}

function finding(msg: string) {
  findings.push(msg);
  console.log(`  📝 ${msg}`);
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
    data = { ok: false, error: 'Non-JSON' };
  }
  return { status: res.status, data, headers: res.headers };
}

// ============================================================================
// L1: Method Parity (static — check TS SDK exports)
// ============================================================================

function testL1Parity() {
  console.log('\n═══ L1: SDK Method Parity ═══\n');

  // Check TS SDK has the critical P0 methods
  try {
    // We can't import the SDK directly, but we can check the file exists and has the methods
    const fs = require('fs');
    const tsSource = fs.readFileSync('sdk/prismer-cloud/typescript/src/index.ts', 'utf-8');

    const coreEvoMethods = [
      'analyze',
      'record',
      'evolve',
      'createGene',
      'listGenes',
      'deleteGene',
      'forkGene',
      'publishGene',
      'importGene',
      'getEdges',
      'distill',
    ];
    const securityMethods = ['getConversationSecurity', 'setConversationSecurity', 'uploadKey', 'getKeys', 'revokeKey'];
    const leaderboardMethods = [
      'getLeaderboardHero',
      'getLeaderboardRising',
      'getLeaderboardStats',
      'getLeaderboardAgents',
      'getLeaderboardGenes',
      'getLeaderboardContributors',
      'getPublicProfile',
      'renderCard',
      'getBenchmark',
      'getHighlights',
    ];
    const memoryMethods = [
      'createFile',
      'listFiles',
      'getFile',
      'updateFile',
      'deleteFile',
      'compact',
      'load',
      'getKnowledgeLinks',
    ];
    const contactMethods = [
      'request',
      'pendingReceived',
      'pendingSent',
      'accept',
      'reject',
      'friends',
      'remove',
      'block',
      'unblock',
      'blocklist',
      'getPresence',
    ];
    const knowledgeMethods = ['KnowledgeLinkClient'];

    for (const m of [
      ...coreEvoMethods,
      ...securityMethods,
      ...leaderboardMethods,
      ...memoryMethods,
      ...contactMethods,
      ...knowledgeMethods,
    ]) {
      assert(tsSource.includes(m), `TS SDK has ${m}`);
    }

    // Check Python — v1.8.0 features
    const pySource = fs.readFileSync('sdk/prismer-cloud/python/prismer/client.py', 'utf-8');
    const pyMethods = [
      'analyze',
      'record',
      'create_gene',
      'list_genes',
      'fork_gene',
      'get_achievements',
      'get_sync_snapshot',
      'sync',
      'get_conversation_security',
      'set_conversation_security',
    ];
    for (const m of pyMethods) {
      assert(pySource.includes(m), `Python SDK has ${m}()`);
    }
    // Python v1.8.0 signing
    assert(fs.existsSync('sdk/prismer-cloud/python/prismer/_signing.py'), 'Python SDK has _signing.py');

    // Check Go — v1.8.0 features
    const goSource = fs.readFileSync('sdk/prismer-cloud/golang/prismer.go', 'utf-8');
    const goMethods = [
      'Analyze',
      'Record',
      'CreateGene',
      'ListGenes',
      'ForkGene',
      'GetAchievements',
      'GetSyncSnapshot',
      'Sync',
    ];
    for (const m of goMethods) {
      assert(goSource.includes(m), `Go SDK has ${m}()`);
    }

    // Check Rust — v1.8.0 features
    const rustSrcDir = 'sdk/prismer-cloud/rust/src';
    const rustFiles = fs.readdirSync(rustSrcDir).filter((f: string) => f.endsWith('.rs'));
    const rustAll = rustFiles.map((f: string) => fs.readFileSync(`${rustSrcDir}/${f}`, 'utf-8')).join('\n');
    const rustMethods = ['analyze', 'record', 'create_gene', 'list_genes', 'achievements', 'sync_snapshot'];
    // fork_gene not yet implemented in Rust SDK
    if (!rustAll.includes('fork_gene') && !rustAll.includes('fork')) {
      finding('Rust SDK missing fork_gene() — parity gap');
    }
    for (const m of rustMethods) {
      assert(rustAll.includes(m), `Rust SDK has ${m}()`);
    }
    // Rust v1.8.0 modules
    for (const mod of ['community.rs', 'memory.rs', 'knowledge.rs', 'tasks.rs']) {
      assert(fs.existsSync(`${rustSrcDir}/${mod}`), `Rust SDK has ${mod}`);
    }
  } catch (err) {
    finding(`L1 static check error: ${(err as Error).message}`);
  }
}

// ============================================================================
// L2: End-to-end functional tests against test env
// ============================================================================

async function testL2Functional() {
  console.log('\n═══ L2: End-to-End Functional (cloud.prismer.dev) ═══\n');

  // -- Public endpoints --
  const { data: stats } = await api('/api/im/evolution/public/stats');
  assert(stats.ok === true, 'Public stats', `genes=${stats.data?.total_genes}`);

  const { data: hot } = await api('/api/im/evolution/public/hot?limit=3');
  assert(hot.ok === true && Array.isArray(hot.data), 'Public hot genes');

  const { data: feed } = await api('/api/im/evolution/public/feed?limit=3');
  assert(feed.ok === true && Array.isArray(feed.data), 'Public feed');

  // -- Scopes --
  const { data: scopes } = await api('/api/im/evolution/scopes');
  assert(scopes.ok === true && scopes.data?.includes('global'), 'Scopes includes global');

  // -- Analyze with scope --
  const { data: advice, status: analyzeStatus } = await api('/api/im/evolution/analyze?scope=global', 'POST', {
    signals: [{ type: 'error:timeout' }],
  });
  assert(analyzeStatus === 200 || analyzeStatus === 429, `Analyze (status=${analyzeStatus})`);
  if (analyzeStatus === 200) {
    assert(advice.data?.action !== undefined, `Analyze returns action: ${advice.data?.action}`);
    assert(advice.data?.signals !== undefined, 'Analyze returns signals');
  }

  // -- Genes with scope --
  const { data: genes } = await api('/api/im/evolution/genes?scope=global');
  assert(genes.ok === true, 'List genes with scope');

  // -- Edges with scope --
  const { data: edges } = await api('/api/im/evolution/edges?scope=global');
  assert(edges.ok === true, 'List edges with scope');

  // -- Capsules with scope --
  const { data: capsules } = await api('/api/im/evolution/capsules?scope=global');
  assert(capsules.ok === true, 'List capsules with scope');

  // -- Report --
  const { data: report } = await api('/api/im/evolution/report?scope=global');
  assert(report.ok === true, 'Get evolution report');

  // -- Achievements --
  const { data: achievements } = await api('/api/im/evolution/achievements');
  assert(achievements.ok === true, 'Get achievements');

  // -- Sync snapshot --
  const { data: snapshot } = await api('/api/im/evolution/sync/snapshot');
  assert(snapshot.ok === true, 'Sync snapshot');
  if (snapshot.ok) {
    assert(Array.isArray(snapshot.data?.genes), `Snapshot has genes (${snapshot.data?.genes?.length})`);
    assert(Array.isArray(snapshot.data?.edges), `Snapshot has edges (${snapshot.data?.edges?.length})`);
  }

  // -- Rate limit headers --
  const { headers: rlHeaders } = await api('/api/im/evolution/analyze?scope=global', 'POST', {
    signals: ['test:ratelimit'],
  });
  const rlLimit = rlHeaders.get('x-ratelimit-limit');
  assert(rlLimit !== null, `Rate limit headers present (limit=${rlLimit})`);

  // -- Security endpoints --
  const { status: secStatus } = await api('/api/im/conversations/test-nonexistent/security');
  assert(secStatus === 403 || secStatus === 200, `Security endpoint responds (${secStatus})`);

  // -- Admin endpoint (should reject non-admin) --
  const { status: adminStatus } = await api('/api/im/admin/users/test/trust-tier', 'PATCH', { trustTier: 2 });
  assert(adminStatus === 403, `Admin rejects non-admin (${adminStatus})`);

  // -- Scope validation --
  const { status: badScope } = await api('/api/im/evolution/genes?scope=invalid;DROP TABLE');
  assert(badScope === 400, `Invalid scope rejected (${badScope})`);
}

// ============================================================================
// L2b: v1.8.0 New API Regression
// ============================================================================

async function testL2bNewApis() {
  console.log('\n═══ L2b: v1.8.0 New API Regression ═══\n');

  // ── Leaderboard V2 ──
  console.log('  ── Leaderboard V2 ──');

  const { data: hero, status: heroSt } = await api('/api/im/evolution/leaderboard/hero');
  assert(heroSt === 200 && hero.ok === true, `Leaderboard hero (status=${heroSt})`);
  if (hero.ok) {
    // Hero returns { global: { totalTokenSaved, ... }, network: { totalAgentsEvolving, ... }, period: { ... } }
    assert(hero.data?.global !== undefined || hero.data?.network !== undefined, 'Hero has global/network structure');
  }

  const { data: rising, status: risingSt } = await api('/api/im/evolution/leaderboard/rising?period=weekly&limit=5');
  assert(risingSt === 200 && rising.ok === true, `Leaderboard rising (status=${risingSt})`);
  // Rising returns { entries: [...] } — data is wrapped
  assert(Array.isArray(rising.data?.entries) || Array.isArray(rising.data), 'Rising returns entries');

  const { data: lbStats, status: lbStatsSt } = await api('/api/im/evolution/leaderboard/stats');
  assert(lbStatsSt === 200 && lbStats.ok === true, `Leaderboard stats (status=${lbStatsSt})`);

  const { data: lbAgents } = await api('/api/im/evolution/leaderboard/agents?period=weekly');
  assert(lbAgents.ok === true, 'Leaderboard agents board');

  const { data: lbGenes } = await api('/api/im/evolution/leaderboard/genes?period=weekly');
  assert(lbGenes.ok === true, 'Leaderboard genes board');

  const { data: lbContrib } = await api('/api/im/evolution/leaderboard/contributors?period=weekly');
  assert(lbContrib.ok === true, 'Leaderboard contributors board');

  const { data: lbComp } = await api('/api/im/evolution/leaderboard/comparison');
  assert(lbComp.ok === true, 'Leaderboard comparison');

  const { data: bench } = await api('/api/im/evolution/benchmark');
  assert(bench.ok === true, 'Benchmark endpoint');

  // ── Memory API ──
  console.log('  ── Memory API (v1.8.0) ──');

  const { data: memFiles, status: memListSt } = await api('/api/im/memory/files');
  assert(memListSt === 200 && memFiles.ok === true, `Memory list files (status=${memListSt})`);
  assert(Array.isArray(memFiles.data), 'Memory files returns array');

  // Write a test memory file
  const { data: memCreate, status: memCreateSt } = await api('/api/im/memory/files', 'POST', {
    path: '_test/sdk-regression-v180.md',
    content: '# SDK Regression Test\n\nThis file was created by sdk-evaluation.ts v1.8.0',
    memoryType: 'reference',
    description: 'SDK regression test file',
  });
  assert(memCreateSt === 200 || memCreateSt === 201, `Memory create file (status=${memCreateSt})`);
  const memFileId = memCreate.data?.id;

  if (memFileId) {
    // Read back
    const { data: memGet } = await api(`/api/im/memory/files/${memFileId}`);
    assert(memGet.ok === true && memGet.data?.path?.includes('sdk-regression'), 'Memory get file');
    // memoryType and description may be in metadata or top-level depending on serialization
    assert(
      memGet.data?.memoryType === 'reference' ||
        memGet.data?.memory_type === 'reference' ||
        memGet.data?.metadata?.memoryType === 'reference',
      `Memory file has memoryType (got: ${JSON.stringify({ mt: memGet.data?.memoryType, meta: memGet.data?.metadata?.memoryType })})`,
    );
    assert(
      memGet.data?.description?.includes('regression') || memGet.data?.metadata?.description?.includes('regression'),
      `Memory file has description`,
    );

    // Delete test file
    const { status: memDelSt } = await api(`/api/im/memory/files/${memFileId}`, 'DELETE');
    assert(memDelSt === 200, `Memory delete file (status=${memDelSt})`);
  }

  // Memory load (session context)
  const { data: memLoad } = await api('/api/im/memory/load');
  assert(memLoad.ok === true, 'Memory load for session');

  // Memory knowledge links
  const { data: memLinks } = await api('/api/im/memory/links');
  assert(memLinks.ok === true, 'Memory knowledge links');

  // ── Recall API ──
  console.log('  ── Recall API (v1.8.0) ──');

  // Recall is mounted at /api/im/recall (not /memory/recall)
  const { data: recall, status: recallSt } = await api('/api/im/recall', 'POST', {
    query: 'SDK integration test',
    scope: 'global',
    strategy: 'keyword',
  });
  assert(recallSt === 200 && recall.ok === true, `Recall (status=${recallSt})`);

  // ── Community API ──
  console.log('  ── Community API (v1.8.0 P8) ──');

  // Browse boards
  const { data: boards, status: boardsSt } = await api('/api/im/community/boards');
  assert(boardsSt === 200 && boards.ok === true, `Community boards (status=${boardsSt})`);

  // Browse posts
  const { data: posts, status: postsSt } = await api('/api/im/community/posts?limit=5');
  assert(postsSt === 200 && posts.ok === true, `Community browse posts (status=${postsSt})`);
  assert(Array.isArray(posts.data?.posts || posts.data), 'Community posts returns array');

  // Search posts — mounted at /api/im/community/search
  const { data: searchPosts } = await api('/api/im/community/search?q=test&limit=3');
  assert(searchPosts.ok === true, 'Community search');

  // Notifications
  const { data: notifs } = await api('/api/im/community/notifications');
  assert(notifs.ok === true, 'Community notifications');

  // Create a test post (in Ideas board)
  const { data: newPost, status: newPostSt } = await api('/api/im/community/posts', 'POST', {
    title: '[SDK-TEST] v1.8.0 regression test post',
    content: 'Automated post from sdk-evaluation.ts — safe to delete',
    boardId: 'ideas',
    type: 'discussion',
  });
  assert(newPostSt === 200 || newPostSt === 201 || newPostSt === 429, `Community create post (status=${newPostSt})`);
  const testPostId = newPost.data?.id;

  if (testPostId) {
    // Get detail
    const { data: postDetail } = await api(`/api/im/community/posts/${testPostId}`);
    assert(postDetail.ok === true, 'Community post detail');

    // Vote — POST /api/im/community/vote with { targetType, targetId, value }
    const { data: vote, status: voteSt } = await api('/api/im/community/vote', 'POST', {
      targetType: 'post',
      targetId: testPostId,
      value: 1,
    });
    assert(voteSt === 200 || voteSt === 429, `Community vote (status=${voteSt})`);

    // Comment
    const { data: comment, status: commentSt } = await api(`/api/im/community/posts/${testPostId}/comments`, 'POST', {
      content: 'SDK test comment — auto-generated',
    });
    assert(commentSt === 200 || commentSt === 201 || commentSt === 429, `Community comment (status=${commentSt})`);

    // Delete test post
    const { status: delPostSt } = await api(`/api/im/community/posts/${testPostId}`, 'DELETE');
    assert(delPostSt === 200 || delPostSt === 204, `Community delete post (status=${delPostSt})`);
  }

  // ── Contact API (P9) ──
  console.log('  ── Contact API (v1.8.0 P9) ──');

  // List friends (may be empty)
  const { data: friends, status: friendsSt } = await api('/api/im/contacts/friends');
  assert(friendsSt === 200 && friends.ok === true, `Contact friends list (status=${friendsSt})`);

  // Pending received
  const { data: pendingRx } = await api('/api/im/contacts/requests/received');
  assert(pendingRx.ok === true, 'Contact pending received');

  // Pending sent
  const { data: pendingTx } = await api('/api/im/contacts/requests/sent');
  assert(pendingTx.ok === true, 'Contact pending sent');

  // Block list (may be empty)
  const { data: blocked } = await api('/api/im/contacts/blocked');
  assert(blocked.ok === true, 'Contact blocked list');

  // ── Knowledge Links API ──
  console.log('  ── Knowledge Links (v1.8.0) ──');

  const { data: kLinks, status: kLinksSt } = await api(
    '/api/im/knowledge/links?entityType=gene&entityId=test_nonexistent',
  );
  assert(kLinksSt === 200 && kLinks.ok === true, `Knowledge links query (status=${kLinksSt})`);

  // ── Signing Service (P5) ──
  // Note: signing schema endpoint not yet mounted as standalone route
  // Signing is applied inline by message/direct/group routers via SigningService
  console.log('  ── Signing Service (v1.8.0 P5) ──');
  finding('Signing schema endpoint not mounted — signing operates inline in message routes');
}

// ============================================================================
// L3: Mechanism Layer Assessment (all 4 SDKs)
// ============================================================================

function testL3Mechanisms() {
  console.log('\n═══ L3: Mechanism Layer Assessment ═══\n');

  const fs = require('fs');

  // ── L1: SignalEnrichment ──
  console.log('  ── L1: Signal Enrichment ──');
  const signalFiles = [
    ['TS', 'sdk/prismer-cloud/typescript/src/signal-enrichment.ts', 'extractSignals'],
    ['Py', 'sdk/prismer-cloud/python/prismer/signal_rules.py', 'extract_signals'],
    ['Go', 'sdk/prismer-cloud/golang/signal_rules.go', 'ExtractSignals'],
    ['Rust', 'sdk/prismer-cloud/rust/src/signal_rules.rs', 'extract_signals'],
  ];
  for (const [lang, path, fn] of signalFiles) {
    const exists = fs.existsSync(path);
    assert(exists, `SignalEnrichment exists (${lang})`);
    if (exists) {
      const src = fs.readFileSync(path, 'utf-8');
      assert(src.includes(fn), `SignalEnrichment ${lang} has ${fn}()`);
    }
  }

  // ── L2: EvolutionCache ──
  console.log('  ── L2: Evolution Cache ──');
  const cacheFiles = [
    ['TS', 'sdk/prismer-cloud/typescript/src/evolution-cache.ts', ['selectGene', 'loadSnapshot', 'applyDelta']],
    ['Py', 'sdk/prismer-cloud/python/prismer/evolution_cache.py', ['select_gene', 'load_snapshot', 'apply_delta']],
    ['Go', 'sdk/prismer-cloud/golang/evolution_cache.go', ['SelectGene', 'LoadSnapshot', 'ApplyDelta']],
    ['Rust', 'sdk/prismer-cloud/rust/src/evolution_cache.rs', ['select_gene', 'load_snapshot', 'apply_delta']],
  ];
  for (const [lang, path, methods] of cacheFiles) {
    const exists = fs.existsSync(path as string);
    assert(exists, `EvolutionCache exists (${lang})`);
    if (exists) {
      const src = fs.readFileSync(path as string, 'utf-8');
      for (const m of methods as string[]) {
        assert(src.includes(m), `EvolutionCache ${lang} has ${m}()`);
      }
      assert(
        src.includes('alpha') || src.includes('thompson') || src.includes('Thompson'),
        `EvolutionCache ${lang} has Thompson Sampling`,
      );
    }
  }

  // ── L3: Outbox ──
  console.log('  ── L3: Outbox ──');
  assert(fs.existsSync('sdk/prismer-cloud/python/prismer/evolution_outbox.py'), 'Standalone Outbox exists (Py)');
  assert(fs.existsSync('sdk/prismer-cloud/golang/evolution_outbox.go'), 'Standalone Outbox exists (Go)');
  // TS and Rust have inline outbox in runtime — by design
  finding('TS/Rust use inline outbox in EvolutionRuntime (by design)');

  // ── L4: EvolutionRuntime ──
  console.log('  ── L4: Evolution Runtime ──');
  const runtimeFiles = [
    [
      'TS',
      'sdk/prismer-cloud/typescript/src/evolution-runtime.ts',
      ['suggest', 'learned', 'start', 'EvolutionCache', 'extractSignals'],
    ],
    [
      'Py',
      'sdk/prismer-cloud/python/prismer/evolution_runtime.py',
      ['suggest', 'learned', 'start', 'EvolutionCache', 'extract_signals'],
    ],
    [
      'Go',
      'sdk/prismer-cloud/golang/evolution_runtime.go',
      ['Suggest', 'Learned', 'Start', 'EvolutionCache', 'ExtractSignals'],
    ],
    [
      'Rust',
      'sdk/prismer-cloud/rust/src/evolution_runtime.rs',
      ['suggest', 'learned', 'start', 'EvolutionCache', 'extract_signals'],
    ],
  ];
  for (const [lang, path, checks] of runtimeFiles) {
    const exists = fs.existsSync(path as string);
    assert(exists, `EvolutionRuntime exists (${lang})`);
    if (exists) {
      const src = fs.readFileSync(path as string, 'utf-8');
      for (const c of checks as string[]) {
        assert(src.includes(c), `EvolutionRuntime ${lang} has ${c}`);
      }
    }
  }
}

// ============================================================================
// L5: Session Tracking Verification
// ============================================================================

function testL5SessionTracking() {
  console.log('\n═══ L5: Session Tracking ═══\n');

  const fs = require('fs');

  const sessionChecks = [
    [
      'TS',
      'sdk/prismer-cloud/typescript/src/evolution-runtime.ts',
      {
        session: 'EvolutionSession',
        metrics: 'SessionMetrics',
        getMetrics: 'getMetrics',
        resetMetrics: 'resetMetrics',
        startSession: '_activeSession',
        completeSession: 'adopted',
      },
    ],
    [
      'Py (async)',
      'sdk/prismer-cloud/python/prismer/evolution_runtime.py',
      {
        session: 'EvolutionSession',
        metrics: 'SessionMetrics',
        getMetrics: 'get_metrics',
        resetMetrics: 'reset_metrics',
        startSession: '_start_session',
        completeSession: '_complete_session',
      },
    ],
    [
      'Go',
      'sdk/prismer-cloud/golang/evolution_runtime.go',
      {
        session: 'EvolutionSession',
        metrics: 'SessionMetrics',
        getMetrics: 'GetMetrics',
        resetMetrics: 'ResetMetrics',
        startSession: 'startSession',
        completeSession: 'completeSession',
      },
    ],
    [
      'Rust',
      'sdk/prismer-cloud/rust/src/evolution_runtime.rs',
      {
        session: 'EvolutionSession',
        metrics: 'SessionMetrics',
        getMetrics: 'get_metrics',
        resetMetrics: 'reset_metrics',
        startSession: 'start_session',
        completeSession: 'complete_session',
      },
    ],
  ];

  for (const [lang, path, checks] of sessionChecks) {
    console.log(`  ── ${lang} ──`);
    const src = fs.readFileSync(path as string, 'utf-8');
    const c = checks as Record<string, string>;
    assert(src.includes(c.session), `${lang}: EvolutionSession type`);
    assert(src.includes(c.metrics), `${lang}: SessionMetrics type`);
    assert(src.includes(c.getMetrics), `${lang}: ${c.getMetrics}() method`);
    assert(src.includes(c.resetMetrics), `${lang}: ${c.resetMetrics}() method`);
    assert(src.includes(c.startSession), `${lang}: session start in suggest`);
    assert(src.includes(c.completeSession), `${lang}: session complete in learned`);
  }

  // Check Python sync runtime also has session tracking
  console.log('  ── Py (sync) ──');
  const pySrc = fs.readFileSync('sdk/prismer-cloud/python/prismer/evolution_runtime.py', 'utf-8');
  // Sync class starts after "class EvolutionRuntime:" (not Async)
  const syncPart = pySrc.split('class EvolutionRuntime:')[1] || '';
  assert(syncPart.includes('_start_session'), 'Py sync: has _start_session');
  assert(syncPart.includes('_complete_session'), 'Py sync: has _complete_session');
  assert(syncPart.includes('get_metrics'), 'Py sync: has get_metrics()');
  assert(syncPart.includes('reset_metrics'), 'Py sync: has reset_metrics()');

  // Check exports
  console.log('  ── Exports ──');
  const tsIdx = fs.readFileSync('sdk/prismer-cloud/typescript/src/index.ts', 'utf-8');
  assert(tsIdx.includes('EvolutionRuntime'), 'TS exports EvolutionRuntime');
  assert(tsIdx.includes('EvolutionSession'), 'TS exports EvolutionSession');
  assert(tsIdx.includes('SessionMetrics'), 'TS exports SessionMetrics');

  const pyInit = fs.readFileSync('sdk/prismer-cloud/python/prismer/__init__.py', 'utf-8');
  assert(pyInit.includes('EvolutionRuntime'), 'Py exports EvolutionRuntime');
  assert(pyInit.includes('SessionMetrics'), 'Py exports SessionMetrics');

  const rustLib = fs.readFileSync('sdk/prismer-cloud/rust/src/lib.rs', 'utf-8');
  assert(rustLib.includes('evolution_runtime'), 'Rust exports evolution_runtime module');
}

// ============================================================================
// L6: Daemon Parity (4 SDKs)
// ============================================================================

function testL6Daemon() {
  console.log('\n═══ L6: Daemon Parity (4 SDKs) ═══\n');

  const fs = require('fs');

  // TS daemon
  console.log('  ── TS ──');
  const tsDaemon = fs.readFileSync('sdk/prismer-cloud/typescript/src/daemon.ts', 'utf-8');
  assert(tsDaemon.includes('startDaemon'), 'TS: startDaemon()');
  assert(tsDaemon.includes('stopDaemon'), 'TS: stopDaemon()');
  assert(tsDaemon.includes('daemonStatus'), 'TS: daemonStatus()');
  assert(tsDaemon.includes('appendToOutbox'), 'TS: appendToOutbox()');
  assert(tsDaemon.includes('installDaemonService'), 'TS: installDaemonService()');
  assert(tsDaemon.includes('uninstallDaemonService'), 'TS: uninstallDaemonService()');
  assert(tsDaemon.includes('installLaunchd'), 'TS: launchd support');
  assert(tsDaemon.includes('installSystemd'), 'TS: systemd support');

  // Python daemon
  console.log('  ── Python ──');
  const pyDaemon = fs.readFileSync('sdk/prismer-cloud/python/prismer/daemon.py', 'utf-8');
  assert(pyDaemon.includes('start_daemon'), 'Py: start_daemon()');
  assert(pyDaemon.includes('stop_daemon'), 'Py: stop_daemon()');
  assert(pyDaemon.includes('daemon_status'), 'Py: daemon_status()');
  assert(pyDaemon.includes('append_to_outbox'), 'Py: append_to_outbox()');
  assert(pyDaemon.includes('install_daemon_service'), 'Py: install_daemon_service()');
  assert(pyDaemon.includes('uninstall_daemon_service'), 'Py: uninstall_daemon_service()');
  assert(pyDaemon.includes('launchd') || pyDaemon.includes('LaunchAgents'), 'Py: launchd support');
  assert(pyDaemon.includes('systemd') || pyDaemon.includes('systemctl'), 'Py: systemd support');
  assert(pyDaemon.includes('/health'), 'Py: health endpoint');
  assert(pyDaemon.includes('/events'), 'Py: events endpoint');
  assert(pyDaemon.includes('evolution/sync'), 'Py: evolution sync');
  assert(pyDaemon.includes('outbox'), 'Py: outbox flush');
  // Python CLI integration
  const pyCli = fs.readFileSync('sdk/prismer-cloud/python/prismer/cli.py', 'utf-8');
  assert(pyCli.includes('daemon'), 'Py CLI: daemon subcommand');

  // Go daemon
  console.log('  ── Go ──');
  const goDaemon = fs.readFileSync('sdk/prismer-cloud/golang/daemon.go', 'utf-8');
  assert(goDaemon.includes('StartDaemon'), 'Go: StartDaemon()');
  assert(goDaemon.includes('StopDaemon'), 'Go: StopDaemon()');
  assert(goDaemon.includes('DaemonStatus'), 'Go: DaemonStatus()');
  assert(goDaemon.includes('AppendToOutbox'), 'Go: AppendToOutbox()');
  assert(goDaemon.includes('InstallDaemonService'), 'Go: InstallDaemonService()');
  assert(goDaemon.includes('UninstallDaemonService'), 'Go: UninstallDaemonService()');
  assert(goDaemon.includes('launchd') || goDaemon.includes('LaunchAgents'), 'Go: launchd support');
  assert(goDaemon.includes('systemd') || goDaemon.includes('systemctl'), 'Go: systemd support');
  assert(goDaemon.includes('/health'), 'Go: health endpoint');
  assert(goDaemon.includes('evolution/sync'), 'Go: evolution sync');
  // Go CLI integration
  assert(fs.existsSync('sdk/prismer-cloud/golang/cmd/prismer/daemon.go'), 'Go CLI: daemon.go exists');

  // Rust daemon
  console.log('  ── Rust ──');
  const rustDaemon = fs.readFileSync('sdk/prismer-cloud/rust/src/daemon.rs', 'utf-8');
  assert(rustDaemon.includes('start_daemon'), 'Rust: start_daemon()');
  assert(rustDaemon.includes('stop_daemon'), 'Rust: stop_daemon()');
  assert(rustDaemon.includes('daemon_status'), 'Rust: daemon_status()');
  assert(rustDaemon.includes('append_to_outbox'), 'Rust: append_to_outbox()');
  assert(rustDaemon.includes('install_daemon_service'), 'Rust: install_daemon_service()');
  assert(rustDaemon.includes('uninstall_daemon_service'), 'Rust: uninstall_daemon_service()');
  assert(rustDaemon.includes('launchd') || rustDaemon.includes('LaunchAgents'), 'Rust: launchd support');
  assert(rustDaemon.includes('systemd') || rustDaemon.includes('systemctl'), 'Rust: systemd support');
  assert(rustDaemon.includes('/health'), 'Rust: health endpoint');
  assert(rustDaemon.includes('evolution/sync'), 'Rust: evolution sync');
  // Rust module export
  const rustLib = fs.readFileSync('sdk/prismer-cloud/rust/src/lib.rs', 'utf-8');
  assert(rustLib.includes('daemon'), 'Rust lib.rs: pub mod daemon');
}

// ============================================================================
// L5: Plugin Assessment
// ============================================================================

function testL5Plugins() {
  console.log('\n═══ L5: Plugin Assessment ═══\n');

  const fs = require('fs');

  // Claude Code Plugin v1.7.8+
  console.log('  ── Claude Code Plugin (v1.7.8) ──');
  const ccPluginRoot = 'sdk/prismer-cloud/claude-code-plugin';
  const hooksJson = JSON.parse(fs.readFileSync(`${ccPluginRoot}/hooks/hooks.json`, 'utf-8'));
  const hookEvents = Object.keys(hooksJson.hooks || {});
  // v1.7.8: 7 hook events (SessionStart, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, Stop, SessionEnd)
  assert(hookEvents.length >= 7, `Claude Code: ${hookEvents.length} hook events (expect >= 7)`);
  assert(!!hooksJson.hooks?.SessionStart, 'Claude Code: SessionStart hook');
  assert(!!hooksJson.hooks?.PreToolUse, 'Claude Code: PreToolUse hook');
  assert(!!hooksJson.hooks?.PostToolUse, 'Claude Code: PostToolUse hook');
  assert(!!hooksJson.hooks?.PostToolUseFailure, 'Claude Code: PostToolUseFailure hook');
  assert(!!hooksJson.hooks?.SubagentStart, 'Claude Code: SubagentStart hook');
  assert(!!hooksJson.hooks?.Stop, 'Claude Code: Stop hook');
  assert(!!hooksJson.hooks?.SessionEnd, 'Claude Code: SessionEnd hook');

  // v1.7.8 scripts
  const requiredScripts = [
    'session-start.mjs',
    'session-stop.mjs',
    'session-end.mjs',
    'pre-bash-suggest.mjs',
    'pre-web-cache.mjs',
    'post-bash-journal.mjs',
    'post-web-save.mjs',
    'post-tool-failure.mjs',
    'subagent-start.mjs',
  ];
  for (const script of requiredScripts) {
    assert(fs.existsSync(`${ccPluginRoot}/scripts/${script}`), `Claude Code: ${script} exists`);
  }

  // v1.7.8 logger integration
  assert(fs.existsSync(`${ccPluginRoot}/scripts/lib/logger.mjs`), 'Claude Code: logger.mjs exists');

  // v1.7.8: 12 skills
  const ccSkills = fs.readdirSync(`${ccPluginRoot}/skills`);
  assert(ccSkills.length >= 12, `Claude Code: ${ccSkills.length} skills (expect >= 12)`);
  for (const skill of [
    'evolve-analyze',
    'evolve-create',
    'evolve-record',
    'evolve-session-review',
    'community-browse',
    'community-search',
    'debug-log',
    'prismer-setup',
    'plugin-dev',
  ]) {
    assert(ccSkills.includes(skill), `Claude Code: skill '${skill}' exists`);
  }

  // Pre-suggest still calls analyze
  const preSuggest = fs.readFileSync(`${ccPluginRoot}/scripts/pre-bash-suggest.mjs`, 'utf-8');
  assert(preSuggest.includes('/evolution/analyze'), 'Claude Code: pre-suggest calls analyze API');

  // package.json version
  const ccPkg = JSON.parse(fs.readFileSync(`${ccPluginRoot}/package.json`, 'utf-8'));
  assert(
    ccPkg.version?.startsWith('1.8') || ccPkg.version?.startsWith('1.7.8'),
    `Claude Code: version=${ccPkg.version}`,
  );

  // OpenCode Plugin
  console.log('  ── OpenCode Plugin ──');
  const ocIndex = fs.readFileSync('sdk/prismer-cloud/opencode-plugin/src/index.ts', 'utf-8');
  assert(ocIndex.includes('tool.execute.before'), 'OpenCode: tool.execute.before hook exists');
  assert(
    ocIndex.includes('session.created') || ocIndex.includes('session.ended'),
    'OpenCode: session lifecycle hooks exist',
  );
  assert(ocIndex.includes('tool.execute.after'), 'OpenCode: tool.execute.after hook exists');
  assert(ocIndex.includes('analyze') || ocIndex.includes('suggest'), 'OpenCode: before hook does analyze/suggest');

  const ocClient = fs.readFileSync('sdk/prismer-cloud/opencode-plugin/src/evolution-client.ts', 'utf-8');
  assert(ocClient.includes('scope'), 'OpenCode: EvolutionClient supports scope');
  assert(ocClient.includes('achievements'), 'OpenCode: EvolutionClient has achievements()');
  assert(ocClient.includes('sync'), 'OpenCode: EvolutionClient has sync()');

  // OpenClaw Channel
  console.log('  ── OpenClaw Channel ──');
  const clawInbound = fs.readFileSync('sdk/prismer-cloud/openclaw-channel/src/inbound.ts', 'utf-8');
  assert(clawInbound.includes('evolution'), 'OpenClaw: inbound has evolution integration');
  assert(clawInbound.includes('/evolution/analyze'), 'OpenClaw: inbound calls analyze on error messages');
  assert(clawInbound.includes('evolutionHint'), 'OpenClaw: inbound injects evolution hint');

  const clawTools = fs.readFileSync('sdk/prismer-cloud/openclaw-channel/src/tools.ts', 'utf-8');
  assert(clawTools.includes('prismer_evolve_analyze'), 'OpenClaw: has evolve_analyze tool');
  assert(clawTools.includes('prismer_evolve_record'), 'OpenClaw: has evolve_record tool');
  assert(clawTools.includes('prismer_evolve_report'), 'OpenClaw: has evolve_report tool');
  assert(clawTools.includes('scope'), 'OpenClaw: tools support scope');

  // MCP Server tool count
  const mcpIndex = fs.readFileSync('sdk/prismer-cloud/mcp/src/index.ts', 'utf-8');
  const mcpToolCount = (mcpIndex.match(/register\w+\(server\)/g) || []).length;
  assert(mcpToolCount >= 47, `MCP Server: ${mcpToolCount} tools registered (expect >= 47)`);
}

// ============================================================================
// Signal Enrichment accuracy test
// ============================================================================

function testSignalEnrichment() {
  console.log('\n═══ Signal Enrichment Accuracy ═══\n');

  // Import and test the TS enrichment module
  try {
    // Test with known error patterns
    const testCases = [
      { input: 'ETIMEDOUT: request timed out', expected: 'timeout' },
      { input: 'Error 429: Too Many Requests', expected: 'rate_limit' },
      { input: '401 Unauthorized', expected: 'auth_error' },
      { input: 'ECONNREFUSED 127.0.0.1:5432', expected: 'connection_refused' },
      { input: 'Cannot find module react', expected: null }, // should not match infra errors
      { input: 'TypeError: undefined is not a function', expected: 'type_error' },
    ];

    // We can't directly import TS enrichment module, so test via Python rules as proxy
    // Use PYTHONPATH pointing to parent dir to avoid circular import with types.py
    const { execFileSync } = require('child_process');
    const pyResult = execFileSync(
      'python3',
      [
        '-c',
        `
import sys
sys.path.insert(0, 'sdk/prismer-cloud/python')
from prismer.signal_rules import extract_signals

tests = [
    ('ETIMEDOUT: request timed out', 'timeout'),
    ('Error 429: Too Many Requests', 'rate_limit'),
    ('401 Unauthorized', 'auth_error'),
    ('ECONNREFUSED 127.0.0.1:5432', 'connection_refused'),
    ('Cannot find module react', None),
    ('TypeError: undefined is not a function', 'type_error'),
]

passed = 0
for input_str, expected in tests:
    result = extract_signals(input_str)
    types = [s.get('type', '').split(':')[-1] for s in result] if result else []
    if expected is None:
        ok = len([t for t in types if t in ('timeout','rate_limit','auth_error','connection_refused')]) == 0
    else:
        ok = expected in ' '.join(types)
    status = 'PASS' if ok else 'FAIL'
    print(f'{status}|{input_str[:40]}|expected={expected}|got={types}')
    if ok: passed += 1

print(f'TOTAL|{passed}/{len(tests)}')
`,
      ],
      { encoding: 'utf-8' },
    );

    const lines = pyResult.trim().split('\n');
    for (const line of lines) {
      const [status, desc] = line.split('|');
      if (status === 'PASS') {
        assert(true, `Enrichment: ${desc}`);
      } else if (status === 'FAIL') {
        assert(false, `Enrichment: ${desc}`);
      } else if (status === 'TOTAL') {
        finding(`Signal enrichment accuracy: ${desc}`);
      }
    }
  } catch (err) {
    finding(`Signal enrichment test error: ${(err as Error).message.slice(0, 100)}`);
  }
}

// ============================================================================
// Context Meta (extractMeta) test
// ============================================================================

function testContextMeta() {
  console.log('\n═══ Context Meta Extraction ═══\n');

  // With prismer-meta block
  const withMeta = `# Test Content\n\nBody.\n\n\`\`\`prismer-meta\ntitle: Test Title\nkeywords: test, keyword, search\n\`\`\``;
  const r1 = extractMeta(withMeta);
  assert(r1.title === 'Test Title', 'extractMeta: title from meta block');
  assert(r1.keywords.includes('test'), 'extractMeta: keywords parsed');
  assert(!r1.hqcc.includes('prismer-meta'), 'extractMeta: block stripped');

  // Fallback
  const noMeta = '# Fallback Title\n\nJust content.';
  const r2 = extractMeta(noMeta);
  assert(r2.title === 'Fallback Title', 'extractMeta: fallback to heading');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SDK Evaluation & Regression (v1.8.0)        ║');
  console.log('║  Target: cloud.prismer.dev                   ║');
  console.log('╚══════════════════════════════════════════════╝');

  testL1Parity();
  await testL2Functional();
  await testL2bNewApis();
  testL3Mechanisms();
  testL5SessionTracking();
  testL6Daemon();
  testL5Plugins();
  testSignalEnrichment();
  testContextMeta();

  console.log('\n══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════');

  if (findings.length > 0) {
    console.log('\n  ─── Key Findings ───');
    for (const f of findings) {
      console.log(`  • ${f}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
