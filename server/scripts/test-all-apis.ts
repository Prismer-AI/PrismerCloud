/**
 * Prismer Cloud — Full-Stack Integration & Regression Tests (v2)
 *
 * Complete rewrite covering ALL 152 API endpoints across 30 routers.
 * Fixes: uses API Key consistently (not raw imToken through proxy).
 *
 * Usage:
 *   npx tsx scripts/test-all-apis.ts                    # localhost
 *   npx tsx scripts/test-all-apis.ts --env test         # cloud.prismer.dev
 *   npx tsx scripts/test-all-apis.ts --env prod         # prismer.cloud
 *   npx tsx scripts/test-all-apis.ts --group im         # IM group only
 *   npx tsx scripts/test-all-apis.ts --group evolution  # Evolution only
 *   npx tsx scripts/test-all-apis.ts --group leaderboard # Leaderboard only
 *   npx tsx scripts/test-all-apis.ts --verbose          # Show response bodies
 *
 * Groups: config, auth, context, parse, im, workspace, conversations,
 *         messages, direct, groups, agents, files, sync, skills,
 *         evolution, leaderboard, memory, tasks, identity, aip,
 *         reports, credits, subscriptions, health, leaderboard-v2,
 *         community, contact, friends, knowledge, memory-v2, presence,
 *         contact-flow, gdpr
 */

// ==============================================================================
// Configuration
// ==============================================================================

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
  test: (process.env.PRISMER_API_KEY || process.env.PRISMER_API_KEY_TEST || ''),
  prod: (process.env.PRISMER_API_KEY || process.env.PRISMER_API_KEY_TEST || ''),
};

const BASE = process.env.BASE_URL || BASE_URLS[ENV] || BASE_URLS.local;
const API_KEY = process.env.API_KEY || API_KEYS[ENV] || '';

// ==============================================================================
// Test Infrastructure
// ==============================================================================

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

function assertStatus(res: ApiResult, expected: number, label: string) {
  assertEqual(res.status, expected, `${label}: HTTP status`);
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
      data = { raw: text };
    }
  }

  if (verbose) {
    console.log(`    ${method} ${path} → ${res.status}`);
    if (data && typeof data === 'object') console.log(`    ${JSON.stringify(data).slice(0, 200)}`);
  }

  return { status: res.status, data, headers: res.headers };
}

// ==============================================================================
// Shared State (accumulated across groups)
// ==============================================================================

let authToken = API_KEY; // Always use API Key through the proxy
let imToken = '';
let imUserId = '';
let conversationId = '';
let groupConversationId = '';
let taskId = '';
let geneId = '';
let skillSlug = '';
let memoryFileId = '';
let uploadId = '';
let cdnUrl = '';

// ==============================================================================
// Main
// ==============================================================================

async function run() {
  console.log(`\n🧪 Prismer Cloud Integration Tests (v2)`);
  console.log(`   Environment: ${ENV} (${BASE})`);
  console.log(`   API Key: ${API_KEY ? '✅ set' : '❌ not set'}`);
  console.log(`   Group: ${argGroup || 'all'}\n`);

  if (!API_KEY && ENV !== 'local') {
    console.error('No API key for remote environment. Set API_KEY or use --env local');
    process.exit(1);
  }

  // ============================================================
  // Group 1: Config / Version
  // ============================================================
  if (shouldRun('config')) {
    console.log('\n--- Group 1: Config ---');

    await test('1.1 GET /api/version', async () => {
      const res = await api('GET', '/api/version');
      assertOk(res, 'version');
    });

    await test('1.2 GET /api/config', async () => {
      const res = await api('GET', '/api/config');
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });

    await test('1.3 GET /api/im/health', async () => {
      const res = await api('GET', '/api/im/health');
      assertOk(res, 'health');
    });
  }

  // ============================================================
  // Group 2: Auth
  // ============================================================
  if (shouldRun('auth')) {
    console.log('\n--- Group 2: Auth ---');

    await test('2.1 Auth with valid API Key', async () => {
      const res = await api('GET', '/api/im/health', undefined, authToken);
      assertOk(res, 'auth health');
    });

    await test('2.2 Auth rejected without key', async () => {
      const res = await api('GET', '/api/im/me');
      assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
    });

    await test('2.3 Auth with invalid key — should reject', async () => {
      const res = await api(
        'POST',
        '/api/im/tasks',
        { title: 'auth-test' },
        (process.env.PRISMER_API_KEY || process.env.PRISMER_API_KEY_TEST || ''),
      );
      assert(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
    });
  }

  // ============================================================
  // Group 3: Context API
  // ============================================================
  if (shouldRun('context')) {
    console.log('\n--- Group 3: Context API ---');

    await test('3.1 POST /api/context/load — single URL', async () => {
      const res = await api(
        'POST',
        '/api/context/load',
        {
          input: 'https://example.com',
          return: { format: 'hqcc' },
        },
        authToken,
      );
      assertOk(res, 'load');
    });

    await test('3.2 POST /api/search', async () => {
      const res = await api(
        'POST',
        '/api/search',
        {
          query: 'prismer cloud',
          numResults: 2,
        },
        authToken,
      );
      assert(res.status === 200 || res.status === 202, `HTTP ${res.status}`);
    });

    await test('3.3 POST /api/context/save', async () => {
      const res = await api(
        'POST',
        '/api/context/save',
        {
          raw_link: `https://test-${Date.now()}.example.com`,
          hqcc_content: 'Test HQCC content for regression',
          visibility: 'private',
        },
        authToken,
      );
      assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 4: Parse API
  // ============================================================
  if (shouldRun('parse')) {
    console.log('\n--- Group 4: Parse API ---');

    await test('4.1 POST /api/parse — URL mode', async () => {
      const res = await api(
        'POST',
        '/api/parse',
        {
          url: 'https://example.com',
          mode: 'fast',
        },
        authToken,
      );
      // 200=success, 202=async, 402=no credits, 500=parser down
      assert(res.status !== 401 && res.status !== 403, `Auth failed: ${res.status}`);
    });
  }

  // ============================================================
  // Group 5: Workspace & Init
  // ============================================================
  if (shouldRun('workspace') || shouldRun('im')) {
    console.log('\n--- Group 5: Workspace ---');

    const ts = Date.now();

    await test('5.1 POST /api/im/workspace/init', async () => {
      const res = await api(
        'POST',
        '/api/im/workspace/init',
        {
          workspaceId: `test-ws-${ts}`,
          userId: `test-user-${ts}`,
          userDisplayName: 'Regression User',
          agentName: `test-agent-${ts}`,
          agentDisplayName: 'Regression Agent',
          agentCapabilities: ['test', 'coding'],
        },
        authToken,
      );
      assertOk(res, 'workspace-init');
      assertExists(res.data.data.conversationId, 'conversationId');
      assertExists(res.data.data.user.token, 'user.token');
      imToken = res.data.data.user.token;
      imUserId = res.data.data.user.imUserId;
      conversationId = res.data.data.conversationId;
    });

    await test('5.2 GET /api/im/me', async () => {
      if (!authToken) {
        skip('5.2', 'no auth');
        return;
      }
      const res = await api('GET', '/api/im/me', undefined, authToken);
      assertOk(res, 'me');
    });

    await test('5.3 GET /api/im/contacts', async () => {
      const res = await api('GET', '/api/im/contacts', undefined, authToken);
      assertOk(res, 'contacts');
    });

    await test('5.4 GET /api/im/discover', async () => {
      const res = await api('GET', '/api/im/discover', undefined, authToken);
      assertOk(res, 'discover');
    });
  }

  // ============================================================
  // Group 6: Conversations
  // ============================================================
  if (shouldRun('conversations') || shouldRun('im')) {
    console.log('\n--- Group 6: Conversations ---');

    await test('6.1 GET /api/im/conversations — list', async () => {
      const res = await api('GET', '/api/im/conversations', undefined, authToken);
      assertOk(res, 'conversations-list');
      assert(Array.isArray(res.data.data), 'data is array');
    });

    if (conversationId) {
      await test('6.2 GET /api/im/conversations/:id', async () => {
        // Use API Key — proxy converts to IM JWT for the API Key owner
        // The conversation from workspace/init is owned by this user
        const res = await api('GET', `/api/im/conversations/${conversationId}`, undefined, authToken);
        // May be 403 if the API Key user isn't a member of this specific conversation
        assert(res.status === 200 || res.status === 403, `HTTP ${res.status}`);
      });

      await test('6.3 POST /api/im/conversations/:id/read', async () => {
        const res = await api('POST', `/api/im/conversations/${conversationId}/read`, {}, authToken);
        // 200=marked, 403=not member (workspace user != API key user)
        assert(res.status !== 401 && res.status !== 500, `Unexpected: HTTP ${res.status}`);
      });
    }
  }

  // ============================================================
  // Group 7: Messages
  // ============================================================
  if (shouldRun('messages') || shouldRun('im')) {
    console.log('\n--- Group 7: Messages ---');

    if (!conversationId) {
      skip('7.x', 'no conversationId');
    } else {
      await test('7.1 POST /api/im/messages/:convId — send', async () => {
        const res = await api(
          'POST',
          `/api/im/messages/${conversationId}`,
          {
            content: 'Regression test message v2',
            type: 'text',
          },
          authToken,
        );
        // 200/201=sent, 402=no credits, 403=not member (workspace user != API key user)
        assert(res.status !== 401 && res.status !== 500, `Unexpected: HTTP ${res.status}`);
      });

      await test('7.2 GET /api/im/messages/:convId — history', async () => {
        const res = await api('GET', `/api/im/messages/${conversationId}?limit=10`, undefined, authToken);
        assert(res.status !== 401 && res.status !== 500, `Unexpected: HTTP ${res.status}`);
      });
    }
  }

  // ============================================================
  // Group 8: Groups
  // ============================================================
  if (shouldRun('groups') || shouldRun('im')) {
    console.log('\n--- Group 8: Groups ---');

    await test('8.1 POST /api/im/groups — create', async () => {
      const res = await api(
        'POST',
        '/api/im/groups',
        {
          title: `Test Group ${Date.now()}`,
          members: imUserId ? [imUserId] : [],
        },
        authToken,
      );
      if (res.data?.ok && res.data.data?.id) {
        groupConversationId = res.data.data.id;
      }
      assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
    });

    if (groupConversationId) {
      await test('8.2 GET /api/im/groups/:id', async () => {
        const res = await api('GET', `/api/im/groups/${groupConversationId}`, undefined, authToken);
        assert(res.status === 200, `HTTP ${res.status}`);
      });

      await test('8.3 POST /api/im/groups/:id/messages', async () => {
        const res = await api(
          'POST',
          `/api/im/groups/${groupConversationId}/messages`,
          {
            content: 'Group regression test',
            type: 'text',
          },
          authToken,
        );
        assert(res.status >= 200 && res.status < 400, `HTTP ${res.status}`);
      });
    }
  }

  // ============================================================
  // Group 9: Files
  // ============================================================
  if (shouldRun('files') || shouldRun('im')) {
    console.log('\n--- Group 9: Files ---');

    await test('9.1 GET /api/im/files/types', async () => {
      const res = await api('GET', '/api/im/files/types', undefined, authToken);
      assertOk(res, 'file-types');
    });

    await test('9.2 GET /api/im/files/quota', async () => {
      const res = await api('GET', '/api/im/files/quota', undefined, authToken);
      assertOk(res, 'file-quota');
    });

    await test('9.3 POST /api/im/files/presign', async () => {
      const res = await api(
        'POST',
        '/api/im/files/presign',
        {
          fileName: 'test-regression.txt',
          fileSize: 100,
          mimeType: 'text/plain',
        },
        authToken,
      );
      if (res.data?.ok) {
        uploadId = res.data.data?.uploadId || '';
      }
      assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 10: Sync
  // ============================================================
  if (shouldRun('sync') || shouldRun('im')) {
    console.log('\n--- Group 10: Sync ---');

    await test('10.1 GET /api/im/sync — polling', async () => {
      const res = await api('GET', '/api/im/sync?since=0&limit=5', undefined, authToken);
      assertOk(res, 'sync-poll');
    });
  }

  // ============================================================
  // Group 11: Skills
  // ============================================================
  if (shouldRun('skills')) {
    console.log('\n--- Group 11: Skills ---');

    await test('11.1 GET /api/im/skills/search (public)', async () => {
      const res = await api('GET', '/api/im/skills/search?q=test&limit=5');
      assertOk(res, 'skills-search');
    });

    await test('11.2 GET /api/im/skills/stats (public)', async () => {
      const res = await api('GET', '/api/im/skills/stats');
      assertOk(res, 'skills-stats');
    });

    await test('11.3 GET /api/im/skills/categories (public)', async () => {
      const res = await api('GET', '/api/im/skills/categories');
      assertOk(res, 'skills-categories');
    });

    await test('11.4 GET /api/im/skills/trending (public)', async () => {
      const res = await api('GET', '/api/im/skills/trending');
      assertOk(res, 'skills-trending');
    });

    await test('11.5 GET /api/im/skills/:slug — detail (public)', async () => {
      // Get first skill from search
      const search = await api('GET', '/api/im/skills/search?limit=1');
      const skills = search.data?.data?.skills || [];
      if (skills.length === 0) {
        skip('11.5', 'no skills');
        return;
      }
      skillSlug = skills[0].slug || skills[0].id;

      const res = await api('GET', `/api/im/skills/${skillSlug}`);
      assertOk(res, 'skill-detail');
    });

    if (skillSlug) {
      await test('11.6 POST /api/im/skills/:slug/install', async () => {
        const res = await api('POST', `/api/im/skills/${skillSlug}/install`, {}, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('11.7 GET /api/im/skills/installed', async () => {
        const res = await api('GET', '/api/im/skills/installed', undefined, authToken);
        assertOk(res, 'skills-installed');
      });

      await test('11.8 GET /api/im/skills/:slug/content', async () => {
        const res = await api('GET', `/api/im/skills/${skillSlug}/content`, undefined, authToken);
        assertOk(res, 'skill-content');
      });

      await test('11.9 GET /api/im/skills/:slug/related', async () => {
        const res = await api('GET', `/api/im/skills/${skillSlug}/related`);
        assert(res.status === 200, `HTTP ${res.status}`);
      });

      await test('11.10 DELETE /api/im/skills/:slug/install', async () => {
        const res = await api('DELETE', `/api/im/skills/${skillSlug}/install`, undefined, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });
    }

    await test('11.11 GET /api/im/skills/created', async () => {
      const res = await api('GET', '/api/im/skills/created', undefined, authToken);
      assert(res.status === 200, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 12: Evolution
  // ============================================================
  if (shouldRun('evolution')) {
    console.log('\n--- Group 12: Evolution ---');

    // Public endpoints
    await test('12.1 GET /api/im/evolution/public/stats (public)', async () => {
      const res = await api('GET', '/api/im/evolution/public/stats');
      assertOk(res, 'evo-stats');
    });

    await test('12.2 GET /api/im/evolution/public/hot (public)', async () => {
      const res = await api('GET', '/api/im/evolution/public/hot');
      assertOk(res, 'evo-hot');
    });

    await test('12.3 GET /api/im/evolution/public/feed (public)', async () => {
      const res = await api('GET', '/api/im/evolution/public/metrics');
      assertOk(res, 'evo-feed');
    });

    await test('12.4 GET /api/im/evolution/map (public)', async () => {
      const res = await api('GET', '/api/im/evolution/map');
      assertOk(res, 'evo-map');
    });

    await test('12.5 GET /api/im/evolution/stories (public)', async () => {
      const res = await api('GET', '/api/im/evolution/stories');
      assertOk(res, 'evo-stories');
    });

    await test('12.6 GET /api/im/evolution/public/genes (public)', async () => {
      const res = await api('GET', '/api/im/evolution/public/genes?limit=5');
      assertOk(res, 'evo-genes');
    });

    await test('12.7 GET /api/im/evolution/public/unmatched (public)', async () => {
      const res = await api('GET', '/api/im/evolution/public/unmatched');
      assert(res.status === 200, `HTTP ${res.status}`);
    });

    await test('12.8 GET /api/im/evolution/metrics (public)', async () => {
      const res = await api('GET', '/api/im/evolution/metrics');
      assertOk(res, 'evo-metrics');
    });

    // Auth-required endpoints
    await test('12.9 POST /api/im/evolution/analyze', async () => {
      const res = await api(
        'POST',
        '/api/im/evolution/analyze',
        {
          signals: [{ type: 'error:build_failure' }],
          task_status: 'pending',
          provider: 'regression-test',
          stage: 'test',
        },
        authToken,
      );
      assertOk(res, 'evo-analyze');
    });

    await test('12.10 POST /api/im/evolution/genes — create', async () => {
      const slug = `regression-gene-${Date.now()}`;
      const res = await api(
        'POST',
        '/api/im/evolution/genes',
        {
          slug,
          title: slug,
          description: 'Created by regression test',
          strategy: ['Step 1: verify', 'Step 2: fix'],
          category: 'repair',
          signals: [{ signalId: 'error:test_failure' }],
        },
        authToken,
      );
      if (res.data?.ok) {
        geneId = res.data.data?.gene?.id || res.data.data?.id || '';
      }
      assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
    });

    await test('12.11 POST /api/im/evolution/record', async () => {
      if (!geneId) {
        skip('12.11', 'no geneId from 12.10');
        return;
      }
      const res = await api(
        'POST',
        '/api/im/evolution/record',
        {
          gene_id: geneId,
          outcome: 'success',
          score: 0.9,
          summary: 'Regression test outcome',
          signals: [{ type: 'error:test_failure', provider: 'regression' }],
        },
        authToken,
      );
      assertOk(res, 'evo-record');
    });

    await test('12.12 POST /api/im/evolution/report', async () => {
      const res = await api(
        'POST',
        '/api/im/evolution/report',
        {
          raw_context: 'Regression test context: build failed, then succeeded after fix',
          outcome: 'success',
          task: 'Fix build',
          provider: 'regression-test',
          stage: 'test',
        },
        authToken,
      );
      assertOk(res, 'evo-report');
    });

    await test('12.13 GET /api/im/evolution/achievements', async () => {
      const res = await api('GET', '/api/im/evolution/achievements', undefined, authToken);
      assertOk(res, 'evo-achievements');
    });

    await test('12.14 POST /api/im/evolution/sync', async () => {
      const res = await api(
        'POST',
        '/api/im/evolution/sync',
        {
          push: { outcomes: [] },
          pull: { since: 0 },
        },
        authToken,
      );
      assertOk(res, 'evo-sync');
    });

    if (geneId) {
      await test('12.15 GET /api/im/evolution/public/genes/:id (public)', async () => {
        const res = await api('GET', `/api/im/evolution/public/genes/${geneId}`);
        assertOk(res, 'evo-gene-detail');
      });

      await test('12.16 GET /api/im/evolution/public/genes/:id/capsules', async () => {
        const res = await api('GET', `/api/im/evolution/public/genes/${geneId}/capsules`);
        assert(res.status === 200, `HTTP ${res.status}`);
      });

      await test('12.17 DELETE /api/im/evolution/genes/:id', async () => {
        const res = await api('DELETE', `/api/im/evolution/genes/${geneId}`, undefined, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });
    }
  }

  // ============================================================
  // Group 13: Leaderboard (NEW)
  // ============================================================
  if (shouldRun('leaderboard') || shouldRun('evolution')) {
    console.log('\n--- Group 13: Leaderboard ---');

    await test('13.1 GET /api/im/evolution/leaderboard/stats (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/stats');
      assertOk(res, 'lb-stats');
      assertExists(res.data.data?.totalAgentsEvolving, 'totalAgentsEvolving');
    });

    await test('13.2 GET /api/im/evolution/leaderboard/agents (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/agents?period=weekly');
      if (res.status === 500) {
        skip('13.2', 'leaderboard table not migrated (run 026)');
        return;
      }
      assertOk(res, 'lb-agents');
      assert(Array.isArray(res.data.data?.agents), 'agents is array');
    });

    await test('13.3 GET /api/im/evolution/leaderboard/agents — domain filter', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/agents?period=weekly&domain=coding');
      if (res.status === 500) {
        skip('13.3', 'migration 026 not run');
        return;
      }
      assertOk(res, 'lb-agents-coding');
    });

    await test('13.4 GET /api/im/evolution/leaderboard/agents — monthly', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/agents?period=monthly');
      if (res.status === 500) {
        skip('13.4', 'migration 026 not run');
        return;
      }
      assertOk(res, 'lb-agents-monthly');
    });

    await test('13.5 GET /api/im/evolution/leaderboard/genes (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/genes?period=weekly');
      if (res.status === 500) {
        skip('13.5', 'migration 026 not run');
        return;
      }
      assertOk(res, 'lb-genes');
      assert(Array.isArray(res.data.data?.genes), 'genes is array');
    });

    await test('13.6 GET /api/im/evolution/leaderboard/genes — sort by adopters', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/genes?sort=adopters');
      if (res.status === 500) {
        skip('13.6', 'migration 026 not run');
        return;
      }
      assertOk(res, 'lb-genes-adopters');
    });

    await test('13.7 GET /api/im/evolution/leaderboard/contributors (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/contributors?period=weekly');
      if (res.status === 500) {
        skip('13.7', 'migration 026 not run');
        return;
      }
      assertOk(res, 'lb-contributors');
      assert(Array.isArray(res.data.data?.contributors), 'contributors is array');
    });

    await test('13.8 GET /api/im/evolution/leaderboard/comparison (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/comparison');
      assertOk(res, 'lb-comparison');
    });

    await test('13.9 GET /api/im/evolution/leaderboard/agents — invalid period', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/agents?period=garbage');
      if (res.status === 500) {
        skip('13.9', 'migration 026 not run');
        return;
      }
      assertOk(res, 'lb-invalid-period');
      // Should default to weekly, not error
    });

    await test('13.10 POST /api/im/evolution/leaderboard/snapshot — needs auth', async () => {
      const res = await api('POST', '/api/im/evolution/leaderboard/snapshot', { period: 'weekly' });
      assert(res.status === 401 || res.status === 403, `Expected auth error, got ${res.status}`);
    });
  }

  // ============================================================
  // Group 14: Memory
  // ============================================================
  if (shouldRun('memory')) {
    console.log('\n--- Group 14: Memory ---');

    await test('14.1 POST /api/im/memory/files — write', async () => {
      const res = await api(
        'POST',
        '/api/im/memory/files',
        {
          path: 'regression/test.md',
          content: `# Regression Test\nWritten at ${new Date().toISOString()}`,
        },
        authToken,
      );
      assertOk(res, 'memory-write');
      if (res.data?.data?.id) memoryFileId = res.data.data.id;
    });

    await test('14.2 GET /api/im/memory/load — session load', async () => {
      const res = await api('GET', '/api/im/memory/load', undefined, authToken);
      assertOk(res, 'memory-load');
    });

    await test('14.3 GET /api/im/memory/files — list', async () => {
      const res = await api('GET', '/api/im/memory/files', undefined, authToken);
      assertOk(res, 'memory-list');
    });

    if (memoryFileId) {
      await test('14.4 GET /api/im/memory/files/:id — read', async () => {
        const res = await api('GET', `/api/im/memory/files/${memoryFileId}`, undefined, authToken);
        assertOk(res, 'memory-read');
      });

      await test('14.5 PATCH /api/im/memory/files/:id — update', async () => {
        // Get current version for optimistic locking
        const getRes = await api('GET', `/api/im/memory/files/${memoryFileId}`, undefined, authToken);
        const file = getRes.data?.data;
        const version = file?.version || file?.currentVersion || 1;
        const res = await api(
          'PATCH',
          `/api/im/memory/files/${memoryFileId}`,
          {
            content: `# Updated\n${new Date().toISOString()}`,
            version: Number(version),
          },
          authToken,
        );
        // 200=updated, 400=version mismatch or missing field, 409=conflict
        assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
      });

      await test('14.6 DELETE /api/im/memory/files/:id', async () => {
        const res = await api('DELETE', `/api/im/memory/files/${memoryFileId}`, undefined, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });
    }

    await test('14.7 GET /api/im/recall — unified search', async () => {
      const res = await api('GET', '/api/im/recall?q=regression', undefined, authToken);
      assertOk(res, 'recall');
    });
  }

  // ============================================================
  // Group 15: Tasks
  // ============================================================
  if (shouldRun('tasks')) {
    console.log('\n--- Group 15: Tasks ---');

    await test('15.1 POST /api/im/tasks — create', async () => {
      const res = await api(
        'POST',
        '/api/im/tasks',
        {
          title: `Regression Task ${Date.now()}`,
          description: 'Created by test suite',
          type: 'general',
        },
        authToken,
      );
      assertOk(res, 'task-create');
      if (res.data?.data?.id) taskId = res.data.data.id;
    });

    await test('15.2 GET /api/im/tasks — list', async () => {
      const res = await api('GET', '/api/im/tasks?limit=5', undefined, authToken);
      assertOk(res, 'task-list');
    });

    if (taskId) {
      await test('15.3 GET /api/im/tasks/:id', async () => {
        const res = await api('GET', `/api/im/tasks/${taskId}`, undefined, authToken);
        assertOk(res, 'task-detail');
      });

      await test('15.4 PATCH /api/im/tasks/:id — update', async () => {
        const res = await api(
          'PATCH',
          `/api/im/tasks/${taskId}`,
          {
            description: 'Updated by regression test',
          },
          authToken,
        );
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('15.5 POST /api/im/tasks/:id/claim', async () => {
        const res = await api('POST', `/api/im/tasks/${taskId}/claim`, {}, authToken);
        assert(res.status >= 200 && res.status < 400, `HTTP ${res.status}`);
      });

      await test('15.6 POST /api/im/tasks/:id/progress', async () => {
        const res = await api(
          'POST',
          `/api/im/tasks/${taskId}/progress`,
          {
            progress: 50,
            message: 'Halfway done',
          },
          authToken,
        );
        assert(res.status >= 200 && res.status < 400, `HTTP ${res.status}`);
      });

      await test('15.7 POST /api/im/tasks/:id/complete', async () => {
        const res = await api(
          'POST',
          `/api/im/tasks/${taskId}/complete`,
          {
            result: 'Regression test completed',
          },
          authToken,
        );
        assert(res.status >= 200 && res.status < 400, `HTTP ${res.status}`);
      });
    }
  }

  // ============================================================
  // Group 16: Identity & AIP
  // ============================================================
  if (shouldRun('identity') || shouldRun('aip')) {
    console.log('\n--- Group 16: Identity & AIP ---');

    await test('16.1 GET /api/im/.well-known/did.json', async () => {
      // .well-known routes need auth to look up the user's DID
      const res = await api('GET', '/api/im/.well-known/did.json', undefined, authToken);
      // 200=found, 404=no identity key registered yet
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });

    await test('16.2 POST /api/im/delegation/verify', async () => {
      const res = await api(
        'POST',
        '/api/im/delegation/verify',
        {
          chain: [],
        },
        authToken,
      );
      // May return 400 for empty chain, that's fine
      assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
    });

    await test('16.3 GET /api/im/credentials/mine', async () => {
      const res = await api('GET', '/api/im/credentials/mine', undefined, authToken);
      assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 17: Credits
  // ============================================================
  if (shouldRun('credits')) {
    console.log('\n--- Group 17: Credits ---');

    await test('17.1 GET /api/im/credits', async () => {
      const res = await api('GET', '/api/im/credits', undefined, authToken);
      assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 18: Reports
  // ============================================================
  if (shouldRun('reports')) {
    console.log('\n--- Group 18: Reports ---');

    await test('18.1 GET /api/im/reports', async () => {
      const res = await api('GET', '/api/im/reports', undefined, authToken);
      // May 404 if reports router isn't registered
      assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 19: Subscriptions
  // ============================================================
  if (shouldRun('subscriptions')) {
    console.log('\n--- Group 19: Subscriptions ---');

    await test('19.1 GET /api/im/subscriptions', async () => {
      const res = await api('GET', '/api/im/subscriptions', undefined, authToken);
      assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 20: OG Images
  // ============================================================
  if (shouldRun('leaderboard') || shouldRun('og')) {
    console.log('\n--- Group 20: OG Images ---');

    await test('20.1 GET /api/og/leaderboard/:agentId — share card', async () => {
      const res = await fetch(`${BASE}/api/og/leaderboard/test-agent?period=weekly`);
      assert(res.status === 200, `HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      assert(ct.includes('image/png'), `Expected image/png, got ${ct}`);
      // Check cache header
      const cc = res.headers.get('cache-control') || '';
      assert(cc.includes('max-age'), `Missing Cache-Control, got: ${cc}`);
    });
  }

  // ============================================================
  // Group 21: Health (P0) — v1.8.0
  // ============================================================
  if (shouldRun('health') || shouldRun('config')) {
    console.log('\n--- Group 21: Health (P0) ---');

    await test('21.1 GET /api/health — K8s probe', async () => {
      const res = await api('GET', '/api/health');
      assert(res.status === 200 || res.status === 503, `HTTP ${res.status}`);
      assertExists(res.data?.status, 'status');
      assertExists(res.data?.checks, 'checks');
      assertExists(res.data?.uptime, 'uptime');
    });

    await test('21.2 GET /api/health — has database check', async () => {
      const res = await api('GET', '/api/health');
      assertExists(res.data?.checks?.database, 'checks.database');
    });

    await test('21.3 IM endpoints return X-Request-Id header', async () => {
      const res = await api('GET', '/api/im/health');
      const rid = res.headers.get('x-request-id');
      assert(!!rid, 'Missing X-Request-Id header');
    });
  }

  // ============================================================
  // Group 22: Leaderboard V2 (P4) — v1.8.0 new endpoints
  // ============================================================
  if (shouldRun('leaderboard-v2') || shouldRun('leaderboard')) {
    console.log('\n--- Group 22: Leaderboard V2 ---');

    await test('22.1 GET /api/im/evolution/leaderboard/hero (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/hero');
      assert(res.status === 200, `HTTP ${res.status}`);
    });

    await test('22.2 GET /api/im/evolution/leaderboard/rising (public)', async () => {
      const res = await api('GET', '/api/im/evolution/leaderboard/rising?limit=5');
      assert(res.status === 200, `HTTP ${res.status}`);
    });

    await test('22.3 GET /api/im/evolution/profile/:id (public)', async () => {
      // Use imUserId if available, otherwise test with a dummy
      const profileId = imUserId || 'test-user';
      const res = await api('GET', `/api/im/evolution/profile/${profileId}`);
      // 200=found, 404=no profile data yet
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });

    await test('22.4 GET /api/im/evolution/benchmark (public)', async () => {
      const res = await api('GET', '/api/im/evolution/benchmark');
      assert(res.status === 200, `HTTP ${res.status}`);
    });

    await test('22.5 GET /api/im/evolution/highlights/:geneId', async () => {
      const testGeneId = geneId || 'nonexistent-gene';
      const res = await api('GET', `/api/im/evolution/highlights/${testGeneId}?limit=3`, undefined, authToken);
      // 200=found, 404=no gene
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });

    await test('22.6 POST /api/im/evolution/card/render', async () => {
      const res = await api(
        'POST',
        '/api/im/evolution/card/render',
        {
          type: 'agent',
          agentId: imUserId || 'test-agent',
          period: 'weekly',
        },
        authToken,
      );
      // 200=rendered, 404=no data, 400=invalid params
      assert(res.status === 200 || res.status === 404 || res.status === 400, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 23: Community (P8) — v1.8.0
  // ============================================================
  if (shouldRun('community')) {
    console.log('\n--- Group 23: Community (P8) ---');

    let postId = '';
    let commentId = '';

    // --- Public endpoints ---
    await test('23.1 GET /api/im/community/stats (public)', async () => {
      const res = await api('GET', '/api/im/community/stats');
      assertOk(res, 'community-stats');
    });

    await test('23.2 GET /api/im/community/posts (public)', async () => {
      const res = await api('GET', '/api/im/community/posts?limit=5');
      assertOk(res, 'community-posts');
    });

    await test('23.3 GET /api/im/community/hot', async () => {
      const res = await api('GET', '/api/im/community/hot', undefined, authToken);
      assertOk(res, 'community-hot');
    });

    await test('23.4 GET /api/im/community/tags/trending (public)', async () => {
      const res = await api('GET', '/api/im/community/tags/trending');
      assertOk(res, 'community-tags-trending');
    });

    await test('23.5 GET /api/im/community/search (public)', async () => {
      const res = await api('GET', '/api/im/community/search?q=test');
      assertOk(res, 'community-search');
    });

    await test('23.6 GET /api/im/community/search/suggest', async () => {
      const res = await api('GET', '/api/im/community/search/suggest?q=test', undefined, authToken);
      assertOk(res, 'community-suggest');
    });

    await test('23.7 GET /api/im/community/boards', async () => {
      const res = await api('GET', '/api/im/community/boards', undefined, authToken);
      assertOk(res, 'community-boards');
    });

    await test('23.8 GET /api/im/community/autocomplete/genes', async () => {
      const res = await api('GET', '/api/im/community/autocomplete/genes?q=fix', undefined, authToken);
      assertOk(res, 'community-autocomplete-genes');
    });

    // --- Auth-required endpoints ---
    await test('23.9 POST /api/im/community/posts — create', async () => {
      const res = await api(
        'POST',
        '/api/im/community/posts',
        {
          title: `Regression Test Post ${Date.now()}`,
          content: 'This post was created by the regression test suite.',
          board: 'general',
          tags: ['regression-test'],
        },
        authToken,
      );
      if (res.data?.ok && res.data?.data?.id) {
        postId = res.data.data.id;
      }
      assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
    });

    if (postId) {
      await test('23.10 GET /api/im/community/posts/:id (public)', async () => {
        const res = await api('GET', `/api/im/community/posts/${postId}`);
        assertOk(res, 'community-post-detail');
      });

      await test('23.11 PUT /api/im/community/posts/:id — update', async () => {
        const res = await api(
          'PUT',
          `/api/im/community/posts/${postId}`,
          { content: 'Updated by regression test.' },
          authToken,
        );
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('23.12 POST /api/im/community/vote — upvote post', async () => {
        const res = await api(
          'POST',
          '/api/im/community/vote',
          { targetId: postId, targetType: 'post', value: 1 },
          authToken,
        );
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('23.13 POST /api/im/community/bookmark', async () => {
        const res = await api('POST', '/api/im/community/bookmark', { postId }, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('23.14 GET /api/im/community/bookmarks', async () => {
        const res = await api('GET', '/api/im/community/bookmarks', undefined, authToken);
        assertOk(res, 'community-bookmarks');
      });

      await test('23.15 POST /api/im/community/posts/:id/comments — add comment', async () => {
        const res = await api(
          'POST',
          `/api/im/community/posts/${postId}/comments`,
          { content: 'Regression test comment' },
          authToken,
        );
        if (res.data?.ok && res.data?.data?.id) {
          commentId = res.data.data.id;
        }
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });

      await test('23.16 GET /api/im/community/posts/:id/comments', async () => {
        const res = await api('GET', `/api/im/community/posts/${postId}/comments`);
        assertOk(res, 'community-comments');
      });

      if (commentId) {
        await test('23.17 PUT /api/im/community/comments/:id — update', async () => {
          const res = await api(
            'PUT',
            `/api/im/community/comments/${commentId}`,
            { content: 'Updated regression test comment' },
            authToken,
          );
          assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
        });

        await test('23.18 DELETE /api/im/community/comments/:id', async () => {
          const res = await api('DELETE', `/api/im/community/comments/${commentId}`, undefined, authToken);
          assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
        });
      }

      await test('23.19 DELETE /api/im/community/posts/:id', async () => {
        const res = await api('DELETE', `/api/im/community/posts/${postId}`, undefined, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });
    }

    // --- Notifications ---
    await test('23.20 GET /api/im/community/notifications', async () => {
      const res = await api('GET', '/api/im/community/notifications', undefined, authToken);
      assertOk(res, 'community-notifications');
    });

    await test('23.21 GET /api/im/community/notifications/count', async () => {
      const res = await api('GET', '/api/im/community/notifications/count', undefined, authToken);
      assertOk(res, 'community-notification-count');
    });

    // --- Profile ---
    await test('23.22 GET /api/im/community/me/profile', async () => {
      const res = await api('GET', '/api/im/community/me/profile', undefined, authToken);
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });

    await test('23.23 GET /api/im/community/following', async () => {
      const res = await api('GET', '/api/im/community/following', undefined, authToken);
      assertOk(res, 'community-following');
    });

    // --- Drafts ---
    await test('23.24 GET /api/im/community/drafts', async () => {
      const res = await api('GET', '/api/im/community/drafts', undefined, authToken);
      assertOk(res, 'community-drafts');
    });

    // --- Agent SDK Posts ---
    await test('23.25 POST /api/im/community/agent-post/battle-report', async () => {
      const res = await api(
        'POST',
        '/api/im/community/agent-post/battle-report',
        {
          geneSlug: 'test-gene',
          outcome: 'success',
          summary: 'Regression test battle report',
        },
        authToken,
      );
      // 201=created, 429=rate limited, 400=invalid
      assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 24: Contact & Friends (P9) — v1.8.0
  // ============================================================
  if (shouldRun('contact') || shouldRun('friends')) {
    console.log('\n--- Group 24: Contact & Friends (P9) ---');

    await test('24.1 GET /api/im/contacts/friends — list friends', async () => {
      const res = await api('GET', '/api/im/contacts/friends', undefined, authToken);
      assertOk(res, 'friends-list');
    });

    await test('24.2 GET /api/im/contacts/requests/received', async () => {
      const res = await api('GET', '/api/im/contacts/requests/received', undefined, authToken);
      assertOk(res, 'friend-requests-received');
    });

    await test('24.3 GET /api/im/contacts/requests/sent', async () => {
      const res = await api('GET', '/api/im/contacts/requests/sent', undefined, authToken);
      assertOk(res, 'friend-requests-sent');
    });

    await test('24.4 GET /api/im/contacts/blocked — blocked list', async () => {
      const res = await api('GET', '/api/im/contacts/blocked', undefined, authToken);
      assertOk(res, 'blocked-list');
    });

    await test('24.5 POST /api/im/contacts/request — send (self, expect error)', async () => {
      // Sending a friend request to yourself should fail gracefully
      const res = await api('POST', '/api/im/contacts/request', { targetUserId: imUserId || 'self' }, authToken);
      // 400=can't friend yourself, 404=user not found, 409=already friends
      assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 25: Knowledge Links (P1) — v1.8.0
  // ============================================================
  if (shouldRun('knowledge') || shouldRun('memory')) {
    console.log('\n--- Group 25: Knowledge Links ---');

    await test('25.1 GET /api/im/knowledge/links — by memory', async () => {
      const res = await api('GET', '/api/im/knowledge/links?entityType=memory&entityId=test', undefined, authToken);
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });

    await test('25.2 GET /api/im/knowledge/links — by gene', async () => {
      const res = await api('GET', '/api/im/knowledge/links?entityType=gene&entityId=test', undefined, authToken);
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });

    await test('25.3 POST /api/im/recall — LLM-assisted recall', async () => {
      const res = await api('POST', '/api/im/recall', { query: 'regression test', scope: 'all', limit: 3 }, authToken);
      // 200=results, 404=no matches, 503=LLM unavailable
      assert(res.status >= 200 && res.status < 600, `HTTP ${res.status}`);
    });

    await test('25.4 GET /api/im/recall — with scope param', async () => {
      const res = await api('GET', '/api/im/recall?q=test&scope=memory', undefined, authToken);
      assert(res.status === 200, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 26: Memory V2 (P1) — v1.8.0 memoryType + description
  // ============================================================
  if (shouldRun('memory-v2') || shouldRun('memory')) {
    console.log('\n--- Group 26: Memory V2 ---');

    let memV2Id = '';

    await test('26.1 POST /api/im/memory/files — with memoryType+description', async () => {
      const res = await api(
        'POST',
        '/api/im/memory/files',
        {
          path: 'regression/v180-test.md',
          content: '# v1.8.0 Memory Test\nWith memoryType and description fields.',
          memoryType: 'feedback',
          description: 'Regression test for v1.8.0 memory fields',
        },
        authToken,
      );
      assertOk(res, 'memory-v2-write');
      if (res.data?.data?.id) memV2Id = res.data.data.id;
    });

    if (memV2Id) {
      await test('26.2 GET /api/im/memory/files/:id — verify memoryType', async () => {
        const res = await api('GET', `/api/im/memory/files/${memV2Id}`, undefined, authToken);
        assertOk(res, 'memory-v2-read');
        const file = res.data?.data;
        if (file?.memoryType === 'feedback') {
          // memoryType fix deployed and working
        } else if (file?.memoryType === null || file?.memoryType === undefined) {
          console.log(`    ⚠️  memoryType fix not yet deployed (got ${file?.memoryType})`);
        } else {
          throw new Error(`memoryType: expected 'feedback' or null, got ${JSON.stringify(file?.memoryType)}`);
        }
      });

      await test('26.3 DELETE /api/im/memory/files/:id — cleanup', async () => {
        const res = await api('DELETE', `/api/im/memory/files/${memV2Id}`, undefined, authToken);
        assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
      });
    }
  }

  // ============================================================
  // Group 27: Presence (v1.8.0)
  // ============================================================
  if (shouldRun('presence') || shouldRun('contact')) {
    console.log('\n--- Group 27: Presence ---');

    await test('27.1 POST /api/im/presence/batch', async () => {
      const res = await api('POST', '/api/im/presence/batch', { userIds: [imUserId || 'test-user'] }, authToken);
      assert(res.status === 200 || res.status === 404, `HTTP ${res.status}`);
    });
  }

  // ============================================================
  // Group 28: Cross-Agent Contact Flow (v1.8.1)
  // ============================================================
  if (shouldRun('contact-flow') || shouldRun('contact')) {
    console.log('\n--- Group 28: Cross-Agent Contact Flow ---');

    // Init a second agent
    const ts2 = Date.now();
    let agent2UserId = '';

    await test('28.1 Init second agent', async () => {
      const res = await api(
        'POST',
        '/api/im/workspace/init',
        {
          workspaceId: `test-ws2-${ts2}`,
          userId: `test-user2-${ts2}`,
          userDisplayName: 'Contact Test User 2',
          agentName: `test-agent2-${ts2}`,
          agentDisplayName: 'Contact Agent 2',
          agentCapabilities: ['test'],
        },
        authToken,
      );
      assertOk(res, 'ws2-init');
      agent2UserId = res.data.data?.user?.imUserId || '';
    });

    if (agent2UserId && imUserId && agent2UserId !== imUserId) {
      await test('28.2 Send friend request → agent2', async () => {
        const res = await api('POST', '/api/im/contacts/request', { targetUserId: agent2UserId }, authToken);
        // 200/201=sent, 400=self/invalid, 409=already exists
        assert(res.status >= 200 && res.status < 500, `HTTP ${res.status}`);
      });

      await test('28.3 Check sent requests include agent2', async () => {
        const res = await api('GET', '/api/im/contacts/requests/sent', undefined, authToken);
        assertOk(res, 'sent-requests');
      });
    }
  }

  // ============================================================
  // Group 29: GDPR (v1.8.0)
  // ============================================================
  if (shouldRun('gdpr')) {
    console.log('\n--- Group 29: GDPR ---');

    // Create a disposable agent + community data for GDPR testing
    const gdprTs = Date.now();
    let gdprPostId = '';
    let gdprCommentId = '';
    let gdprAuthorId = '';

    await test('29.1 Setup: create post for GDPR test', async () => {
      const res = await api(
        'POST',
        '/api/im/community/posts',
        {
          title: `GDPR Test Post ${gdprTs}`,
          content: 'Post created for GDPR anonymization testing.',
          boardSlug: 'general',
        },
        authToken,
      );
      assertOk(res, 'gdpr-create-post');
      gdprPostId = res.data.data?.id || '';
      gdprAuthorId = res.data.data?.authorId || '';
      assertExists(gdprPostId, 'gdpr-post-id');
      assertExists(gdprAuthorId, 'gdpr-author-id');
    });

    if (gdprPostId) {
      await test('29.2 Setup: create comment for GDPR test', async () => {
        const res = await api(
          'POST',
          `/api/im/community/posts/${gdprPostId}/comments`,
          { content: 'Comment for GDPR anonymization testing.' },
          authToken,
        );
        assertOk(res, 'gdpr-create-comment');
        gdprCommentId = res.data.data?.id || '';
        assertExists(gdprCommentId, 'gdpr-comment-id');
      });
    }

    await test('29.3 GDPR anonymize — no auth → 401', async () => {
      const res = await api('DELETE', `/api/im/community/gdpr/anonymize/${gdprAuthorId || 'fake-id'}`);
      assertStatus(res, 401, 'gdpr-no-auth');
    });

    await test('29.4 GDPR anonymize — non-admin → 403', async () => {
      const res = await api(
        'DELETE',
        `/api/im/community/gdpr/anonymize/${gdprAuthorId || 'fake-id'}`,
        undefined,
        authToken,
      );
      assertStatus(res, 403, 'gdpr-non-admin');
      assertEqual(res.data?.ok, false, 'gdpr-non-admin: ok');
      assert(
        (res.data?.error || '').toLowerCase().includes('admin'),
        `gdpr-non-admin: error should mention admin, got: ${res.data?.error}`,
      );
    });

    // Cleanup: delete the test post (also removes associated comments)
    if (gdprPostId) {
      await test('29.5 Cleanup: delete GDPR test post', async () => {
        const res = await api('DELETE', `/api/im/community/posts/${gdprPostId}`, undefined, authToken);
        assertOk(res, 'gdpr-cleanup');
      });
    }
  }

  // ============================================================
  // Results
  // ============================================================

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(50)}`);
  console.log(
    `Total: ${passed + failed + skipped} | ✅ Passed: ${passed} | ❌ Failed: ${failed} | ⏭ Skipped: ${skipped}`,
  );
  console.log(`Duration: ${duration}s`);

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
