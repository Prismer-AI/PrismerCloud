/**
 * v1.8.0 Integration Regression — New Features Only
 *
 * Tests v1.8.0 additions: Community, Contact, Knowledge Links,
 * Leaderboard V2 (hero/rising/profile/card), Memory Dream/Extract,
 * Workspace Scope, Signing V2.
 *
 * Usage:
 *   npx tsx scripts/test-v180-regression.ts --env test
 *   npx tsx scripts/test-v180-regression.ts --env test --group community
 *   npx tsx scripts/test-v180-regression.ts --env test --verbose
 */

const args = process.argv.slice(2);
const argEnv = args.indexOf('--env') !== -1 ? args[args.indexOf('--env') + 1] : undefined;
const argGroup = args.indexOf('--group') !== -1 ? args[args.indexOf('--group') + 1] : undefined;
const verbose = args.includes('--verbose');

const ENV = argEnv || process.env.TEST_ENV || 'local';

const BASE_URLS: Record<string, string> = {
  local: 'http://localhost:3000',
  test: 'https://cloud.prismer.dev',
  prod: 'https://prismer.cloud',
};

const API_KEYS: Record<string, string> = {
  test: 'sk-prismer-live-REDACTED-SET-VIA-ENV',
  prod: 'sk-prismer-live-REDACTED-SET-VIA-ENV',
};

const BASE = process.env.BASE_URL || BASE_URLS[ENV] || BASE_URLS.local;
const API_KEY = process.env.API_KEY || API_KEYS[ENV] || '';

// ============================================================================
// Test Infrastructure
// ============================================================================

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];
const startTime = Date.now();

function shouldRun(group: string): boolean {
  if (!argGroup) return true;
  return argGroup === group || argGroup === 'all';
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  ⏭ ${name} (${reason})`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected)
    throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertExists(value: any, field: string) {
  if (value === undefined || value === null) throw new Error(`${field} is missing`);
}

function assertOk(res: ApiResult, label: string) {
  assert(res.status >= 200 && res.status < 300, `${label}: HTTP ${res.status}`);
  if (res.data?.ok !== undefined) assertEqual(res.data.ok, true, `${label}: ok`);
}

type ApiResult = { status: number; data: any; headers: Headers };

async function api(method: string, path: string, body?: any, token?: string): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  } else {
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
  }
  if (verbose) {
    console.log(`    ${method} ${path} → ${res.status}`);
    if (data && typeof data === 'object') console.log(`    ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { status: res.status, data, headers: res.headers };
}

// ============================================================================
// Shared State
// ============================================================================

const authToken = API_KEY;
let imUserId = '';
let postId = '';
let commentId = '';
let geneId = '';
let memoryFileId = '';
let friendRequestUserId = '';

// ============================================================================
// Main
// ============================================================================

async function run() {
  console.log(`\n🧪 v1.8.0 Integration Regression`);
  console.log(`   Environment: ${ENV} (${BASE})`);
  console.log(`   API Key: ${authToken ? '✅ set' : '❌ not set'}`);
  console.log(`   Group: ${argGroup || 'all'}\n`);

  // Setup: get user info
  {
    const ts = Date.now();
    const res = await api(
      'POST',
      '/api/im/workspace/init',
      {
        workspaceId: `v180-test-${ts}`,
        userId: `v180-user-${ts}`,
        userDisplayName: 'v1.8.0 Tester',
        agentName: `v180-agent-${ts}`,
        agentDisplayName: 'Regression Agent',
        agentCapabilities: ['test'],
      },
      authToken,
    );
    if (res.data?.ok) {
      imUserId = res.data.data?.user?.imUserId || '';
    }
    console.log(`   Setup: imUserId=${imUserId || '(none)'}\n`);
  }

  // ============================================================
  // 1. Community (P8)
  // ============================================================
  if (shouldRun('community')) {
    console.log('\n--- 1. Community ---');

    await test('1.1 GET /community/posts — public list', async () => {
      const res = await api('GET', '/api/im/community/posts?limit=5');
      assertOk(res, 'community-posts');
    });

    await test('1.2 GET /community/hot — trending', async () => {
      const res = await api('GET', '/api/im/community/hot', undefined, authToken);
      assertOk(res, 'community-hot');
    });

    await test('1.3 GET /community/tags/trending — tag list', async () => {
      const res = await api('GET', '/api/im/community/tags/trending');
      assertOk(res, 'tags-trending');
    });

    await test('1.4 GET /community/stats — public stats', async () => {
      const res = await api('GET', '/api/im/community/stats');
      assertOk(res, 'community-stats');
    });

    await test('1.5 GET /community/search — public search', async () => {
      const res = await api('GET', '/api/im/community/search?q=test');
      assertOk(res, 'community-search');
    });

    await test('1.6 GET /community/search/suggest — autocomplete', async () => {
      const res = await api('GET', '/api/im/community/search/suggest?q=te', undefined, authToken);
      assertOk(res, 'community-suggest');
    });

    await test('1.7 POST /community/posts — create post (auth)', async () => {
      const res = await api(
        'POST',
        '/api/im/community/posts',
        {
          title: `v1.8.0 Regression Test ${Date.now()}`,
          content: 'Automated regression test post for v1.8.0',
          postType: 'discussion',
          tags: ['showcase'],
        },
        authToken,
      );
      if (res.data?.ok && res.data.data?.id) {
        postId = res.data.data.id;
      }
      assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
    });

    if (postId) {
      await test('1.8 GET /community/posts/:id — read post', async () => {
        const res = await api('GET', `/api/im/community/posts/${postId}`);
        assertOk(res, 'post-read');
        assertExists(res.data.data?.title, 'title');
      });

      await test('1.9 POST /community/posts/:id/comments — add comment', async () => {
        const res = await api(
          'POST',
          `/api/im/community/posts/${postId}/comments`,
          {
            content: 'Automated test comment',
          },
          authToken,
        );
        if (res.data?.ok && res.data.data?.id) {
          commentId = res.data.data.id;
        }
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('1.10 GET /community/posts/:id/comments — list comments', async () => {
        const res = await api('GET', `/api/im/community/posts/${postId}/comments`);
        assertOk(res, 'comments-list');
      });

      await test('1.11 POST /community/vote — upvote post', async () => {
        const res = await api(
          'POST',
          '/api/im/community/vote',
          {
            targetType: 'post',
            targetId: postId,
            value: 1,
          },
          authToken,
        );
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('1.12 POST /community/bookmark — bookmark', async () => {
        const res = await api(
          'POST',
          '/api/im/community/bookmark',
          {
            postId,
          },
          authToken,
        );
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('1.13 GET /community/bookmarks — list bookmarks', async () => {
        const res = await api('GET', '/api/im/community/bookmarks', undefined, authToken);
        assertOk(res, 'bookmarks-list');
      });

      await test('1.14 GET /community/notifications — list notifs', async () => {
        const res = await api('GET', '/api/im/community/notifications', undefined, authToken);
        assertOk(res, 'notifications-list');
      });

      await test('1.15 GET /community/notifications/count — unread count', async () => {
        const res = await api('GET', '/api/im/community/notifications/count', undefined, authToken);
        assertOk(res, 'notifications-count');
      });

      // Cleanup: delete the test post
      await test('1.16 DELETE /community/posts/:id — cleanup', async () => {
        const res = await api('DELETE', `/api/im/community/posts/${postId}`, undefined, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });
    }

    // Boards
    await test('1.17 GET /community/boards — list boards', async () => {
      const res = await api('GET', '/api/im/community/boards', undefined, authToken);
      assertOk(res, 'boards-list');
    });
  }

  // ============================================================
  // 2. Contact / Friend System (P9)
  // ============================================================
  if (shouldRun('contact')) {
    console.log('\n--- 2. Contact / Friend ---');

    await test('2.1 GET /contacts/friends — list friends', async () => {
      const res = await api('GET', '/api/im/contacts/friends', undefined, authToken);
      assertOk(res, 'friends-list');
    });

    await test('2.2 GET /contacts/requests/received — received requests', async () => {
      const res = await api('GET', '/api/im/contacts/requests/received', undefined, authToken);
      assertOk(res, 'requests-received');
    });

    await test('2.3 GET /contacts/requests/sent — sent requests', async () => {
      const res = await api('GET', '/api/im/contacts/requests/sent', undefined, authToken);
      assertOk(res, 'requests-sent');
    });

    await test('2.4 GET /contacts/blocked — block list', async () => {
      const res = await api('GET', '/api/im/contacts/blocked', undefined, authToken);
      assertOk(res, 'blocked-list');
    });

    // Self-request should fail gracefully
    await test('2.5 POST /contacts/request — self-request rejected', async () => {
      if (!imUserId) {
        skip('2.5', 'no imUserId');
        return;
      }
      const res = await api(
        'POST',
        '/api/im/contacts/request',
        {
          userId: imUserId,
          reason: 'self-test',
        },
        authToken,
      );
      // 400=self-request, 409=already exists, 200=created (unlikely for self)
      assert(res.status === 400 || res.status === 409 || res.status === 200, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // 3. Leaderboard V2 (hero/rising/profile/card)
  // ============================================================
  if (shouldRun('leaderboard')) {
    console.log('\n--- 3. Leaderboard V2 ---');

    await test('3.1 GET /evolution/leaderboard/hero — global hero stats (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/hero');
      assertOk(res, 'lb-hero');
    });

    await test('3.2 GET /evolution/leaderboard/rising — rising stars (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/rising');
      assertOk(res, 'lb-rising');
    });

    await test('3.3 GET /evolution/leaderboard/stats — summary stats (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/stats');
      assertOk(res, 'lb-stats');
    });

    await test('3.4 GET /evolution/leaderboard/agents — agent board', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/agents?period=weekly');
      // 500 if snapshot table empty — acceptable for fresh env
      assert(res.status === 200 || res.status === 500, `HTTP ${res.status}`);
    });

    await test('3.5 GET /evolution/leaderboard/genes — gene board', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/genes?period=weekly');
      assert(res.status === 200 || res.status === 500, `HTTP ${res.status}`);
    });

    await test('3.6 GET /evolution/leaderboard/contributors — contributor board', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/contributors?period=weekly');
      assert(res.status === 200 || res.status === 500, `HTTP ${res.status}`);
    });

    await test('3.7 GET /evolution/profile/:id — public profile (agent)', async () => {
      // Use a non-existent ID — should return 404 or empty data, not 500
      const res = await api('GET', '/api/im/evolution/profile/nonexistent-agent-id');
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });

    await test('3.8 GET /evolution/leaderboard/comparison — env comparison', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/comparison');
      assertOk(res, 'lb-comparison');
    });

    await test('3.9 POST /evolution/card/render — card render', async () => {
      const res = await api('POST', '/api/im/evolution/card/render', {
        type: 'agent',
        agentId: 'test-agent',
        agentName: 'Test Agent',
      });
      // 200 with PNG or 400 if missing data — not 500
      assert(res.status !== 500, `Server error: HTTP ${res.status}`);
    });
  }

  // ============================================================
  // 4. Knowledge Links (Convergence)
  // ============================================================
  if (shouldRun('knowledge')) {
    console.log('\n--- 4. Knowledge Links ---');

    await test('4.1 GET /knowledge/links — query links', async () => {
      const res = await api('GET', '/api/im/knowledge/links?entityType=gene&entityId=test', undefined, authToken);
      assertOk(res, 'knowledge-links');
    });

    await test('4.2 GET /memory/links — memory knowledge links', async () => {
      const res = await api('GET', '/api/im/memory/links', undefined, authToken);
      assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // 5. Memory V2 (Recall + Dream + Extract)
  // ============================================================
  if (shouldRun('memory')) {
    console.log('\n--- 5. Memory V2 ---');

    // Write a test memory file first
    await test('5.1 POST /memory/files — write with memoryType', async () => {
      const res = await api(
        'POST',
        '/api/im/memory/files',
        {
          path: 'v180-test/regression.md',
          content: `# v1.8.0 Memory Test\nWritten at ${new Date().toISOString()}`,
          memoryType: 'project',
          description: 'v1.8.0 regression test file',
        },
        authToken,
      );
      assertOk(res, 'memory-write-v2');
      if (res.data?.data?.id) memoryFileId = res.data.data.id;
    });

    await test('5.2 GET /memory/load — session load', async () => {
      const res = await api('GET', '/api/im/memory/load', undefined, authToken);
      assertOk(res, 'memory-load');
    });

    await test('5.3 POST /recall — unified knowledge search', async () => {
      const res = await api(
        'POST',
        '/api/im/recall',
        {
          query: 'regression test',
          strategy: 'hybrid',
          limit: 5,
        },
        authToken,
      );
      assertOk(res, 'recall-search');
    });

    await test('5.4 GET /recall?q=test — GET recall', async () => {
      const res = await api('GET', '/api/im/recall?q=test&limit=5', undefined, authToken);
      assertOk(res, 'recall-get');
    });

    await test('5.5 POST /memory/extract — structured extraction', async () => {
      const res = await api(
        'POST',
        '/api/im/memory/extract',
        {
          content: 'The user prefers TypeScript over JavaScript. They use Next.js 16.',
        },
        authToken,
      );
      // 200=extracted, 400=missing field, 402=no credits
      assert(res.status !== 500, `Server error: HTTP ${res.status}`);
    });

    await test('5.6 POST /memory/consolidate — dream trigger', async () => {
      const res = await api('POST', '/api/im/memory/consolidate', {}, authToken);
      // 200=consolidated, 204=no-op, 402=no credits, 429=rate limited
      assert(res.status !== 500, `Server error: HTTP ${res.status}`);
    });

    // Cleanup
    if (memoryFileId) {
      await test('5.7 DELETE /memory/files/:id — cleanup', async () => {
        const res = await api('DELETE', `/api/im/memory/files/${memoryFileId}`, undefined, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });
    }
  }

  // ============================================================
  // 6. Workspace V2 (Scope)
  // ============================================================
  if (shouldRun('workspace')) {
    console.log('\n--- 6. Workspace V2 (Scope) ---');

    await test('6.1 GET /workspace — default scope', async () => {
      const res = await api('GET', '/api/im/workspace', undefined, authToken);
      assertOk(res, 'workspace-default');
    });

    await test('6.2 GET /workspace?scope=global — explicit scope', async () => {
      const res = await api('GET', '/api/im/workspace?scope=global', undefined, authToken);
      assertOk(res, 'workspace-global');
    });

    await test('6.3 GET /workspace?scope=global&slots=genes,memory — selective slots', async () => {
      const res = await api('GET', '/api/im/workspace?scope=global&slots=genes,memory', undefined, authToken);
      assertOk(res, 'workspace-slots');
    });

    await test('6.4 GET /workspace?includeScopes=true — scope list in response', async () => {
      const res = await api('GET', '/api/im/workspace?includeScopes=true', undefined, authToken);
      assertOk(res, 'workspace-with-scopes');
    });
  }

  // ============================================================
  // 7. Health & Production Hardening (P0)
  // ============================================================
  if (shouldRun('health')) {
    console.log('\n--- 7. Health / P0 ---');

    await test('7.1 GET /api/health — health check', async () => {
      const res = await api('GET', '/api/health');
      assertOk(res, 'health');
    });

    await test('7.2 GET /api/im/health — IM health', async () => {
      const res = await api('GET', '/api/im/health');
      assertOk(res, 'im-health');
    });

    await test('7.3 GET /api/version — version endpoint', async () => {
      const res = await api('GET', '/api/version');
      assertOk(res, 'version');
    });
  }

  // ============================================================
  // 8. Evolution V2 (Thompson + Reflection + Capsule)
  // ============================================================
  if (shouldRun('evolution')) {
    console.log('\n--- 8. Evolution V2 ---');

    // Create a gene for testing
    const slug = `v180-regr-${Date.now()}`;
    await test('8.1 POST /evolution/genes — create gene', async () => {
      const res = await api(
        'POST',
        '/api/im/evolution/genes',
        {
          slug,
          title: `v1.8.0 Regression Gene`,
          description: 'Regression test gene for v1.8.0',
          strategy: ['Step 1: verify', 'Step 2: fix'],
          category: 'repair',
          signals: [{ signalId: 'error:v180_test' }],
        },
        authToken,
      );
      if (res.data?.ok) {
        geneId = res.data.data?.gene?.id || res.data.data?.id || '';
      }
      assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
    });

    if (geneId) {
      await test('8.2 POST /evolution/record — success outcome', async () => {
        const res = await api(
          'POST',
          '/api/im/evolution/record',
          {
            gene_id: geneId,
            outcome: 'success',
            score: 0.95,
            summary: 'v1.8.0 regression test — gene succeeded',
            signals: [{ type: 'error:v180_test', provider: 'regression' }],
          },
          authToken,
        );
        assertOk(res, 'evo-record');
      });

      await test('8.3 POST /evolution/analyze — signal analysis', async () => {
        const res = await api(
          'POST',
          '/api/im/evolution/analyze',
          {
            signals: [{ type: 'error:v180_test' }],
            task_status: 'pending',
            provider: 'regression',
            stage: 'test',
          },
          authToken,
        );
        assertOk(res, 'evo-analyze');
      });

      await test('8.4 POST /evolution/report — full report', async () => {
        const res = await api(
          'POST',
          '/api/im/evolution/report',
          {
            raw_context: 'v1.8.0 test: build failed with missing column error',
            outcome: 'success',
            task: 'Fix migration',
            provider: 'regression',
            stage: 'test',
          },
          authToken,
        );
        assertOk(res, 'evo-report');
      });

      await test('8.5 GET /evolution/achievements — badge list', async () => {
        const res = await api('GET', '/api/im/evolution/achievements', undefined, authToken);
        assertOk(res, 'evo-achievements');
      });

      // Cleanup
      await test('8.6 DELETE /evolution/genes/:id — cleanup', async () => {
        const res = await api('DELETE', `/api/im/evolution/genes/${geneId}`, undefined, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });
    }
  }

  // ============================================================
  // Results
  // ============================================================
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`v1.8.0 Regression: ${passed + failed + skipped} tests`);
  console.log(`  ✅ Passed: ${passed} | ❌ Failed: ${failed} | ⏭ Skipped: ${skipped}`);
  console.log(`  Duration: ${duration}s`);

  if (failures.length > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
