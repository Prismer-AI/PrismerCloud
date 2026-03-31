#!/usr/bin/env npx tsx
/**
 * MCP Server Tool Test Suite
 * Tests all 29 tools by calling the underlying Prismer APIs directly.
 *
 * Usage:
 *   PRISMER_API_KEY=sk-prismer-live-xxx npx tsx sdk/mcp/test-mcp-tools.ts [--env prod|test]
 */

const ENV = process.argv.includes('--env')
  ? process.argv[process.argv.indexOf('--env') + 1]
  : 'prod';

const CONFIG: Record<string, { baseUrl: string; apiKey: string }> = {
  local: {
    baseUrl: 'http://localhost:3000',
    apiKey: process.env.PRISMER_API_KEY || 'sk-prismer-live-d567c1a0e6421c6d8fb2d44276d34d8b98a45fc8e69c9dfe09ba35d1847e85a2',
  },
  prod: {
    baseUrl: 'https://prismer.cloud',
    apiKey: process.env.PRISMER_API_KEY || 'sk-prismer-live-d567c1a0e6421c6d8fb2d44276d34d8b98a45fc8e69c9dfe09ba35d1847e85a2',
  },
  test: {
    baseUrl: 'https://cloud.prismer.dev',
    apiKey: process.env.PRISMER_API_KEY_TEST || 'sk-prismer-live-789b08c3fd7abfd6cfbdf9ca40f2a62106418d906d5eaa8164535bf7a1ef03cd',
  },
};

const { baseUrl, apiKey } = CONFIG[ENV] || CONFIG.prod;

// ── Helpers ────────────────────────────────────────────────────────
interface TestResult {
  name: string;
  tool: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  time: number;
  detail?: string;
}

const results: TestResult[] = [];
let createdGeneId: string | undefined;
let createdMessageId: string | undefined;
let createdConversationId: string | undefined;
let discoveredAgentId: string | undefined;
let createdTaskId: string | undefined;
let publishedGeneId: string | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, string> } = {}
): Promise<unknown> {
  const url = new URL(path, baseUrl);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, _status: response.status };
  }
}

async function runTest(
  name: string,
  tool: string,
  fn: () => Promise<{ ok: boolean; detail?: string }>
) {
  const start = Date.now();
  try {
    const { ok, detail } = await fn();
    results.push({
      name,
      tool,
      status: ok ? 'PASS' : 'FAIL',
      time: Date.now() - start,
      detail,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({
      name,
      tool,
      status: 'FAIL',
      time: Date.now() - start,
      detail: msg,
    });
  }
}

// ── Tests ──────────────────────────────────────────────────────────

// ─── Group 1: Context API ───
async function testContextLoad() {
  await runTest('Context Load (single URL)', 'context_load', async () => {
    const res = (await apiFetch('/api/context/load', {
      method: 'POST',
      body: { input: 'https://example.com' },
    })) as Record<string, unknown>;
    const ok = res.success === true;
    return { ok, detail: ok ? `cached=${!!(res as any).result?.cached}` : JSON.stringify(res.error || res).slice(0, 200) };
  });

  await runTest('Context Load (search query)', 'context_load', async () => {
    const res = (await apiFetch('/api/context/load', {
      method: 'POST',
      body: { input: 'what is prismer cloud', return: { topK: 2 } },
    })) as Record<string, unknown>;
    const ok = res.success === true;
    const count = Array.isArray((res as any).results) ? (res as any).results.length : 0;
    return { ok, detail: ok ? `results=${count}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testContextSave() {
  await runTest('Context Save', 'context_save', async () => {
    const res = (await apiFetch('/api/context/save', {
      method: 'POST',
      body: {
        url: 'https://test-mcp-' + Date.now() + '.example.com',
        hqcc: 'MCP test content ' + new Date().toISOString(),
        title: 'MCP Test',
        visibility: 'private',
      },
    })) as Record<string, unknown>;
    const ok = res.success === true;
    return { ok, detail: ok ? `content_uri=${(res as any).content_uri || 'N/A'}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testContextLoadRawFormat() {
  await runTest('Context Load (format=raw)', 'context_load', async () => {
    const res = (await apiFetch('/api/context/load', {
      method: 'POST',
      body: { input: 'https://example.com', format: 'raw' },
    })) as Record<string, unknown>;
    const ok = res.success === true;
    return { ok, detail: ok ? `format=raw` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testContextLoadError() {
  await runTest('Context Load (missing input — error)', 'context_load', async () => {
    const res = (await apiFetch('/api/context/load', {
      method: 'POST',
      body: {},
    })) as Record<string, unknown>;
    // Expect failure since input is required
    const ok = res.success === false || !!(res as any).error;
    return { ok, detail: ok ? 'correctly rejected missing input' : 'expected error but got success' };
  });
}

async function testContextSaveError() {
  await runTest('Context Save (missing body — error)', 'context_save', async () => {
    const res = (await apiFetch('/api/context/save', {
      method: 'POST',
      body: {},
    })) as Record<string, unknown>;
    const ok = res.success === false || !!(res as any).error;
    return { ok, detail: ok ? 'correctly rejected empty save' : 'expected error but got success' };
  });
}

// ─── Group 2: Parse API ───
async function testParse() {
  await runTest('Parse Document', 'parse_document', async () => {
    const res = (await apiFetch('/api/parse', {
      method: 'POST',
      body: { url: 'https://arxiv.org/pdf/2301.00234v1', mode: 'fast' },
    })) as Record<string, unknown>;
    const ok = res.success === true;
    const hasDoc = !!(res as any).document;
    return { ok, detail: ok ? `hasDocument=${hasDoc}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testParseError() {
  await runTest('Parse Document (missing url — error)', 'parse_document', async () => {
    const res = (await apiFetch('/api/parse', {
      method: 'POST',
      body: {},
    })) as Record<string, unknown>;
    const ok = res.success === false || !!(res as any).error;
    return { ok, detail: ok ? 'correctly rejected missing url' : 'expected error but got success' };
  });
}

// ─── Group 3: IM - Discover ───
async function testDiscover() {
  await runTest('Discover Agents', 'discover_agents', async () => {
    const res = (await apiFetch('/api/im/agents')) as Record<string, unknown>;
    const ok = res.ok === true;
    const agents = (res.data || []) as Record<string, unknown>[];
    if (agents.length > 0) {
      discoveredAgentId = (agents[0].userId || agents[0].agentId) as string;
    }
    return { ok, detail: ok ? `agents=${agents.length}, first=${discoveredAgentId || 'none'}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

// ─── Group 4: IM - Messaging ───
async function testSendMessage() {
  await runTest('Send Message', 'send_message', async () => {
    if (!discoveredAgentId) {
      return { ok: false, detail: 'SKIP: no agent discovered' };
    }
    const res = (await apiFetch(`/api/im/direct/${discoveredAgentId}/messages`, {
      method: 'POST',
      body: { content: `MCP test message ${new Date().toISOString()}`, type: 'text' },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    const msg = data?.message as Record<string, unknown> | undefined;
    createdMessageId = msg?.id as string;
    createdConversationId = msg?.conversationId as string;
    return { ok, detail: ok ? `msgId=${createdMessageId}, convId=${createdConversationId}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEditMessage() {
  await runTest('Edit Message', 'edit_message', async () => {
    if (!createdConversationId || !createdMessageId) {
      return { ok: false, detail: 'SKIP: no message to edit' };
    }
    const res = (await apiFetch(`/api/im/messages/${createdConversationId}/${createdMessageId}`, {
      method: 'PATCH',
      body: { content: `MCP test edited ${new Date().toISOString()}` },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    return { ok, detail: ok ? 'edited' : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testDeleteMessage() {
  await runTest('Delete Message', 'delete_message', async () => {
    if (!createdConversationId || !createdMessageId) {
      return { ok: false, detail: 'SKIP: no message to delete' };
    }
    const res = (await apiFetch(`/api/im/messages/${createdConversationId}/${createdMessageId}`, {
      method: 'DELETE',
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    return { ok, detail: ok ? 'deleted' : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testSendMessageError() {
  await runTest('Send Message (invalid recipient — error)', 'send_message', async () => {
    const res = (await apiFetch('/api/im/direct/nonexistent-user-id-999/messages', {
      method: 'POST',
      body: { content: 'test', type: 'text' },
    })) as Record<string, unknown>;
    const ok = res.ok === false || !!(res as any).error;
    return { ok, detail: ok ? 'correctly rejected invalid recipient' : 'expected error but got success' };
  });
}

// ─── Group 5: Evolution ───
async function testEvolveAnalyze() {
  await runTest('Evolve Analyze', 'evolve_analyze', async () => {
    const res = (await apiFetch('/api/im/evolution/analyze', {
      method: 'POST',
      body: {
        task_status: 'failed',
        error: 'timeout after 30s',
        signals: [{ type: 'error:timeout', provider: 'openai', stage: 'fetch', severity: 'high' }],
      },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `action=${data?.action}, confidence=${data?.confidence}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveCreateGene() {
  await runTest('Evolve Create Gene', 'evolve_create_gene', async () => {
    const res = (await apiFetch('/api/im/evolution/genes', {
      method: 'POST',
      body: {
        category: 'diagnostic',
        signals_match: ['mcp:test:' + Date.now()],
        strategy: ['Step 1: This is a MCP test gene', 'Step 2: Delete after testing'],
        title: 'MCP Test Gene ' + new Date().toISOString(),
      },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    createdGeneId = data?.id as string;
    return { ok, detail: ok ? `geneId=${createdGeneId}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveRecord() {
  await runTest('Evolve Record', 'evolve_record', async () => {
    if (!createdGeneId) {
      return { ok: false, detail: 'SKIP: no gene to record against' };
    }
    const res = (await apiFetch('/api/im/evolution/record', {
      method: 'POST',
      body: {
        gene_id: createdGeneId,
        signals: ['mcp:test'],
        outcome: 'success',
        score: 0.9,
        summary: 'MCP tool test — gene execution recorded',
      },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `edge=${data?.edge_updated}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveDistill() {
  await runTest('Evolve Distill (dry_run)', 'evolve_distill', async () => {
    const res = (await apiFetch('/api/im/evolution/distill?dry_run=true', {
      method: 'POST',
      body: {},
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `ready=${data?.ready}, capsules=${data?.success_capsules}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveBrowse() {
  await runTest('Evolve Browse', 'evolve_browse', async () => {
    const res = (await apiFetch('/api/im/evolution/public/genes', {
      query: { limit: '3' },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const genes = (res.data || []) as Record<string, unknown>[];
    return { ok, detail: ok ? `genes=${genes.length}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveReport() {
  await runTest('Evolve Report', 'evolve_report', async () => {
    const res = (await apiFetch('/api/im/evolution/report', {
      method: 'POST',
      body: {
        raw_context: 'MCP test report: everything works',
        outcome: 'success',
        task_context: 'Testing MCP tool suite',
      },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `trace_id=${data?.trace_id}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveAchievements() {
  await runTest('Evolve Achievements', 'evolve_achievements', async () => {
    const res = (await apiFetch('/api/im/evolution/achievements')) as Record<string, unknown>;
    const ok = res.ok === true;
    const achievements = (res.data || []) as Record<string, unknown>[];
    return { ok, detail: ok ? `achievements=${achievements.length}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveSync() {
  await runTest('Evolve Sync', 'evolve_sync', async () => {
    const res = (await apiFetch('/api/im/evolution/sync', {
      method: 'POST',
      body: { pull: { since: 0 } },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    const pulled = data?.pulled as Record<string, unknown> | undefined;
    const genes = Array.isArray(pulled?.genes) ? pulled!.genes.length : 0;
    return { ok, detail: ok ? `pulled_genes=${genes}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveExportSkill() {
  await runTest('Evolve Export Skill', 'evolve_export_skill', async () => {
    if (!createdGeneId) {
      return { ok: false, detail: 'SKIP: no gene to export' };
    }
    const res = (await apiFetch(`/api/im/evolution/genes/${encodeURIComponent(createdGeneId)}/export-skill`, {
      method: 'POST',
      body: { slug: `mcp-test-${Date.now()}` },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    const skill = data?.skill as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `skill=${skill?.slug}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveImport() {
  await runTest('Evolve Import (browse+import)', 'evolve_import', async () => {
    // First browse to find a public gene
    const browseRes = (await apiFetch('/api/im/evolution/public/genes', {
      query: { limit: '1' },
    })) as Record<string, unknown>;
    const genes = ((browseRes.data || []) as Record<string, unknown>[]);
    if (genes.length === 0) {
      return { ok: true, detail: 'SKIP: no public genes to import' };
    }
    const geneId = genes[0].id as string;
    const res = (await apiFetch('/api/im/evolution/genes/import', {
      method: 'POST',
      body: { gene_id: geneId },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    return { ok, detail: ok ? `imported=${geneId}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolvePublish() {
  await runTest('Evolve Publish', 'evolve_publish', async () => {
    if (!createdGeneId) {
      return { ok: false, detail: 'SKIP: no gene to publish' };
    }
    const res = (await apiFetch(`/api/im/evolution/genes/${encodeURIComponent(createdGeneId)}/publish`, {
      method: 'POST',
      body: { skipCanary: true },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    if (ok) publishedGeneId = createdGeneId;
    const data = res.data as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `visibility=${data?.visibility}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveDelete() {
  await runTest('Evolve Delete', 'evolve_delete', async () => {
    if (!createdGeneId) {
      return { ok: false, detail: 'SKIP: no gene to delete' };
    }
    const res = (await apiFetch(`/api/im/evolution/genes/${encodeURIComponent(createdGeneId)}`, {
      method: 'DELETE',
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    return { ok, detail: ok ? `deleted=${createdGeneId}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testSkillSync() {
  await runTest('Skill Sync', 'skill_sync', async () => {
    // skill_sync relies on /api/im/skills/installed — just verify the API call succeeds
    const res = (await apiFetch('/api/im/skills/installed')) as Record<string, unknown>;
    const ok = res.ok === true;
    const skills = (res.data || []) as Record<string, unknown>[];
    return { ok, detail: ok ? `installed_skills=${skills.length} (sync would download these)` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

// ─── Evolution error & variant tests ───
async function testEvolveBrowseWithCategory() {
  await runTest('Evolve Browse (category=diagnostic)', 'evolve_browse', async () => {
    const res = (await apiFetch('/api/im/evolution/public/genes', {
      query: { limit: '3', category: 'diagnostic' },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const genes = (res.data || []) as Record<string, unknown>[];
    return { ok, detail: ok ? `genes=${genes.length}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveBrowseWithSearch() {
  await runTest('Evolve Browse (search=test)', 'evolve_browse', async () => {
    const res = (await apiFetch('/api/im/evolution/public/genes', {
      query: { limit: '3', search: 'test' },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const genes = (res.data || []) as Record<string, unknown>[];
    return { ok, detail: ok ? `genes=${genes.length}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveRecordFailed() {
  await runTest('Evolve Record (outcome=failed)', 'evolve_record', async () => {
    // Create a throwaway gene for failed record test
    const createRes = (await apiFetch('/api/im/evolution/genes', {
      method: 'POST',
      body: {
        category: 'diagnostic',
        signals_match: ['mcp:error-test:' + Date.now()],
        strategy: ['Step 1: Test failed outcome'],
        title: 'MCP Failed Outcome Test ' + new Date().toISOString(),
      },
    })) as Record<string, unknown>;
    const geneData = createRes.data as Record<string, unknown> | undefined;
    const geneId = geneData?.id as string;
    if (!geneId) {
      return { ok: false, detail: 'SKIP: could not create gene for failed record test' };
    }
    const res = (await apiFetch('/api/im/evolution/record', {
      method: 'POST',
      body: {
        gene_id: geneId,
        signals: ['mcp:error-test'],
        outcome: 'failed',
        score: 0.1,
        summary: 'MCP tool test — recording a failed outcome',
      },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    // Clean up
    await apiFetch(`/api/im/evolution/genes/${encodeURIComponent(geneId)}`, { method: 'DELETE' });
    return { ok, detail: ok ? `edge=${data?.edge_updated}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveSyncWithPush() {
  await runTest('Evolve Sync (push with outcomes)', 'evolve_sync', async () => {
    const res = (await apiFetch('/api/im/evolution/sync', {
      method: 'POST',
      body: {
        pull: { since: 0 },
        push: {
          outcomes: [
            { signals: ['mcp:sync-test'], outcome: 'success', score: 0.8, summary: 'sync push test' },
          ],
        },
      },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    const pulled = data?.pulled as Record<string, unknown> | undefined;
    const pushed = data?.pushed as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `pulled_genes=${Array.isArray(pulled?.genes) ? pulled!.genes.length : 0}, pushed=${JSON.stringify(pushed || {}).slice(0, 80)}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testEvolveCreateGeneError() {
  await runTest('Evolve Create Gene (missing fields — error)', 'evolve_create_gene', async () => {
    const res = (await apiFetch('/api/im/evolution/genes', {
      method: 'POST',
      body: {},
    })) as Record<string, unknown>;
    const ok = res.ok === false || !!(res as any).error;
    return { ok, detail: ok ? 'correctly rejected empty gene' : 'expected error but got success' };
  });
}

async function testEvolveDeleteError() {
  await runTest('Evolve Delete (nonexistent — error)', 'evolve_delete', async () => {
    const res = (await apiFetch('/api/im/evolution/genes/nonexistent-gene-id-999', {
      method: 'DELETE',
    })) as Record<string, unknown>;
    const ok = res.ok === false || !!(res as any).error;
    return { ok, detail: ok ? 'correctly rejected nonexistent gene' : 'expected error but got success' };
  });
}

// ─── Group 6: Memory ───
async function testMemoryWrite() {
  await runTest('Memory Write', 'memory_write', async () => {
    const res = (await apiFetch('/api/im/memory/files', {
      method: 'POST',
      body: {
        path: 'mcp-test.md',
        content: `# MCP Test Memory\nWritten at ${new Date().toISOString()}`,
        scope: 'global',
      },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `version=${data?.version}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testMemoryRead() {
  await runTest('Memory Read', 'memory_read', async () => {
    const res = (await apiFetch('/api/im/memory/load', {
      query: { scope: 'global', path: 'mcp-test.md' },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    const hasContent = !!(data?.content);
    return { ok, detail: ok ? `hasContent=${hasContent}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testRecall() {
  await runTest('Recall', 'recall', async () => {
    const res = (await apiFetch('/api/im/recall', {
      query: { q: 'test', scope: 'all', limit: '5' },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = (res.data || []) as Record<string, unknown>[];
    return { ok, detail: ok ? `results=${data.length}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testMemoryReadError() {
  await runTest('Memory Read (nonexistent path — error)', 'memory_read', async () => {
    const res = (await apiFetch('/api/im/memory/load', {
      query: { scope: 'global', path: 'does-not-exist-' + Date.now() + '.md' },
    })) as Record<string, unknown>;
    // Should return ok but with empty/null content, or an error
    const data = res.data as Record<string, unknown> | undefined;
    const hasNoContent = !data?.content;
    const ok = hasNoContent || res.ok === false;
    return { ok, detail: ok ? 'correctly handled nonexistent path' : 'unexpected content for nonexistent path' };
  });
}

// ─── Group 7: Tasks ───
async function testCreateTask() {
  await runTest('Create Task', 'create_task', async () => {
    const res = (await apiFetch('/api/im/tasks', {
      method: 'POST',
      body: {
        title: 'MCP Test Task ' + new Date().toISOString(),
        description: 'Test task created by MCP tool test suite',
        capability: 'test',
      },
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    createdTaskId = data?.id as string;
    return { ok, detail: ok ? `taskId=${createdTaskId}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testCreateTaskError() {
  await runTest('Create Task (missing title — error)', 'create_task', async () => {
    const res = (await apiFetch('/api/im/tasks', {
      method: 'POST',
      body: {},
    })) as Record<string, unknown>;
    const ok = res.ok === false || !!(res as any).error;
    return { ok, detail: ok ? 'correctly rejected empty task' : 'expected error but got success' };
  });
}

// ─── Group 8: Skills ───
async function testSkillSearch() {
  await runTest('Skill Search', 'skill_search', async () => {
    const res = (await apiFetch('/api/im/skills/search', {
      query: { limit: '5' },
    })) as Record<string, unknown>;
    // skill_search accepts both res.ok and res.data
    const ok = res.ok === true || Array.isArray(res.data);
    const skills = (res.data || []) as Record<string, unknown>[];
    return { ok, detail: ok ? `skills=${skills.length}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testSkillInstalled() {
  await runTest('Skill Installed', 'skill_installed', async () => {
    const res = (await apiFetch('/api/im/skills/installed')) as Record<string, unknown>;
    const ok = res.ok === true;
    const skills = (res.data || []) as Record<string, unknown>[];
    return { ok, detail: ok ? `installed=${skills.length}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testSkillContent() {
  await runTest('Skill Content', 'skill_content', async () => {
    // First search for a skill
    const searchRes = (await apiFetch('/api/im/skills/search', {
      query: { limit: '1' },
    })) as Record<string, unknown>;
    const skills = ((searchRes.data || []) as Record<string, unknown>[]);
    if (skills.length === 0) {
      return { ok: true, detail: 'SKIP: no skills in catalog' };
    }
    const slug = skills[0].slug as string;
    const res = (await apiFetch(`/api/im/skills/${encodeURIComponent(slug)}/content`)) as Record<string, unknown>;
    const ok = res.ok === true;
    const data = res.data as Record<string, unknown> | undefined;
    return { ok, detail: ok ? `slug=${slug}, hasContent=${!!(data?.content)}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

// skill_install and skill_uninstall are tested together
async function testSkillInstallUninstall() {
  // Find a skill to install
  const searchRes = (await apiFetch('/api/im/skills/search', {
    query: { limit: '1' },
  })) as Record<string, unknown>;
  const skills = ((searchRes.data || []) as Record<string, unknown>[]);

  if (skills.length === 0) {
    await runTest('Skill Install', 'skill_install', async () => ({ ok: true, detail: 'SKIP: no skills' }));
    await runTest('Skill Uninstall', 'skill_uninstall', async () => ({ ok: true, detail: 'SKIP: no skills' }));
    return;
  }

  const slug = skills[0].slug as string;

  await runTest('Skill Install', 'skill_install', async () => {
    const res = (await apiFetch(`/api/im/skills/${encodeURIComponent(slug)}/install`, {
      method: 'POST',
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    return { ok, detail: ok ? `installed=${slug}` : JSON.stringify(res.error || res).slice(0, 200) };
  });

  await runTest('Skill Uninstall', 'skill_uninstall', async () => {
    const res = (await apiFetch(`/api/im/skills/${encodeURIComponent(slug)}/install`, {
      method: 'DELETE',
    })) as Record<string, unknown>;
    const ok = res.ok === true;
    return { ok, detail: ok ? `uninstalled=${slug}` : JSON.stringify(res.error || res).slice(0, 200) };
  });
}

async function testSkillContentError() {
  await runTest('Skill Content (nonexistent slug — error)', 'skill_content', async () => {
    const res = (await apiFetch('/api/im/skills/nonexistent-skill-slug-999/content')) as Record<string, unknown>;
    const ok = res.ok === false || !!(res as any).error;
    return { ok, detail: ok ? 'correctly rejected nonexistent skill' : 'expected error but got success' };
  });
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔧 MCP Server Tool Test Suite`);
  console.log(`   Environment: ${ENV} (${baseUrl})`);
  console.log(`   API Key: ${apiKey.slice(0, 20)}...${apiKey.slice(-6)}`);
  console.log(`   Tools: 29\n`);
  console.log('─'.repeat(80));

  // Run tests in dependency order
  console.log('\n📦 Group 1: Context API');
  await testContextLoad();
  await testContextLoadRawFormat();
  await testContextSave();
  await testContextLoadError();
  await testContextSaveError();

  console.log('\n📄 Group 2: Parse API');
  await testParse();
  await testParseError();

  console.log('\n🤖 Group 3: IM - Discovery');
  await testDiscover();

  console.log('\n💬 Group 4: IM - Messaging');
  await testSendMessage();
  await testEditMessage();
  await testDeleteMessage();
  await testSendMessageError();

  console.log('\n🧬 Group 5: Evolution');
  await testEvolveAnalyze();
  await testEvolveCreateGene();
  await testEvolveRecord();
  await testEvolveRecordFailed();
  await testEvolveDistill();
  await testEvolveBrowse();
  await testEvolveBrowseWithCategory();
  await testEvolveBrowseWithSearch();
  await testEvolveReport();
  await testEvolveAchievements();
  await testEvolveSync();
  await testEvolveSyncWithPush();
  await testEvolveExportSkill();
  await testEvolveImport();
  await testEvolvePublish();
  await testEvolveDelete();
  await testEvolveCreateGeneError();
  await testEvolveDeleteError();

  console.log('\n🧠 Group 6: Memory');
  await testMemoryWrite();
  await testMemoryRead();
  await testRecall();
  await testMemoryReadError();

  console.log('\n📋 Group 7: Tasks');
  await testCreateTask();
  await testCreateTaskError();

  console.log('\n🛠️  Group 8: Skills');
  await testSkillSearch();
  await testSkillInstalled();
  await testSkillContent();
  await testSkillInstallUninstall();
  await testSkillContentError();
  await testSkillSync();

  // ── Report ─────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log('\n📊 Test Results:\n');

  const groups: Record<string, TestResult[]> = {};
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⏭️' : '❌';
    console.log(`  ${icon} ${r.name.padEnd(35)} ${r.tool.padEnd(25)} ${r.time}ms`);
    if (r.detail) console.log(`     ${r.detail}`);
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const total = results.length;

  console.log('\n' + '─'.repeat(80));
  console.log(`\n  Total: ${total} | ✅ Pass: ${passed} | ❌ Fail: ${failed} | ⏭️ Skip: ${skipped}`);
  console.log(`  Time: ${results.reduce((sum, r) => sum + r.time, 0)}ms\n`);

  if (failed > 0) {
    console.log('  ❌ FAILED TESTS:');
    for (const r of results.filter((r) => r.status === 'FAIL')) {
      console.log(`     - ${r.name} (${r.tool}): ${r.detail}`);
    }
    console.log('');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
