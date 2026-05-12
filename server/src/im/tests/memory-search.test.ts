/**
 * MemorySearchService (A5) integration tests + small ranker fixture eval.
 *
 * Run:
 *   rm -f /tmp/prismer-memory-search.db
 *   DATABASE_URL="file:/tmp/prismer-memory-search.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-memory-search.db" npx tsx src/im/tests/memory-search.test.ts
 *
 * The brief calls for 50 (query, expectedPageId) pairs with top-3 hit ≥ 80%
 * for production benchmarking. We embed a 10-pair fixture here for unit-test
 * coverage; the larger benchmark belongs in `benchmark/scripts/memory-search-eval.ts`
 * so it can run against MySQL under realistic data volume.
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import prisma from '../db';
import { _clearMemoryAclCache, loadWorkspaceForMemoryAccess } from '../services/memory-acl';
import { MemorySearchError, MemorySearchService } from '../services/memory-search.service';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ownerId = `ms_owner_${suffix}`;
const agent1Id = `ms_agent1_${suffix}`;
const ws = `ms_ws_${suffix}`;

const search = new MemorySearchService();
let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
  _clearMemoryAclCache();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function cleanup() {
  await prisma.iMMemoryLink.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMMemoryPageVersion.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMMemoryFile.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMAgentCard.deleteMany({ where: { imUserId: agent1Id } });
  await prisma.iMWorkspace.deleteMany({ where: { id: ws } });
  await prisma.iMUser.deleteMany({ where: { id: { in: [ownerId, agent1Id] } } });
}

const FIXTURE_PAGES: Array<{
  id: string;
  path: string;
  title: string;
  pageType: string;
  content: string;
  visibility: string;
  stale?: boolean;
  inboundLinks?: number;
}> = [
  {
    id: 'pg_decision_auth',
    path: 'memory/decisions/auth-rotation.md',
    title: 'Auth key rotation decision',
    pageType: 'leaf',
    content:
      '# Auth key rotation\n\n## Context\nWe rotate JWT signing keys every 30 days because of compliance requirements.\n\n## Decision\nDual-key rotation with 7 day overlap so live tokens stay valid during cutover.\n',
    visibility: 'workspace',
    inboundLinks: 3,
  },
  {
    id: 'pg_glossary_jwt',
    path: 'memory/glossary/jwt.md',
    title: 'JWT — glossary entry',
    pageType: 'leaf',
    content:
      '# JWT\n\nJSON Web Token. Compact URL-safe means of representing claims to be transferred between two parties. Signed using RS256 in this codebase.\n',
    visibility: 'workspace',
    inboundLinks: 5,
  },
  {
    id: 'pg_hub_security',
    path: 'memory/hubs/security.md',
    title: 'Security hub',
    pageType: 'hub',
    content:
      '# Security\n\n- [auth rotation](memory/decisions/auth-rotation.md)\n- [jwt glossary](memory/glossary/jwt.md)\n- [encryption modes](memory/specs/encryption.md)\n',
    visibility: 'workspace',
    inboundLinks: 1,
  },
  {
    id: 'pg_decision_db',
    path: 'memory/decisions/database-choice.md',
    title: 'Database choice — MySQL 8',
    pageType: 'leaf',
    content:
      '# Database choice\n\n## Context\nProd needs HA + boring tech.\n\n## Decision\nMySQL 8 with regional read replicas. SQLite for dev only.\n',
    visibility: 'workspace',
  },
  {
    id: 'pg_glossary_acl',
    path: 'memory/glossary/acl.md',
    title: 'ACL — visibility values',
    pageType: 'leaf',
    content:
      '# ACL\n\nVisibility values: workspace, agent:<id>, human:<id>, task:<id>. Owner human reads all delegated agents; agents read workspace + agent:self only.\n',
    visibility: 'workspace',
    inboundLinks: 2,
  },
  {
    id: 'pg_stale_old',
    path: 'memory/decisions/old-vendor-choice.md',
    title: 'Vendor choice (DEPRECATED)',
    pageType: 'leaf',
    content: '# Vendor choice\n\nWe used to use Vendor X for OCR. Replaced with Parser service in v1.6.\n',
    visibility: 'workspace',
    stale: true,
  },
  {
    id: 'pg_agent_secret',
    path: 'memory/private/agent1-prefs.md',
    title: 'Agent 1 preferences',
    pageType: 'leaf',
    content: '# Agent 1 prefs\n\nPrefers terse responses, default to `--no-color`. Owner: human.\n',
    visibility: `agent:${agent1Id}`,
  },
  {
    id: 'pg_human_secret',
    path: 'memory/private/owner-prefs.md',
    title: 'Owner preferences',
    pageType: 'leaf',
    content: '# Owner prefs\n\nReview cadence weekly Friday afternoon.\n',
    visibility: `human:${ownerId}`,
  },
  {
    id: 'pg_index',
    path: 'INDEX.md',
    title: 'Index',
    pageType: 'hub',
    content: '# Index\n\n- decisions/\n- glossary/\n- hubs/\n',
    visibility: 'workspace',
  },
  {
    id: 'pg_runbook',
    path: 'memory/runbooks/deploy.md',
    title: 'Deploy runbook',
    pageType: 'leaf',
    content: '# Deploy runbook\n\n1. Tag commit `prod-YYYYMMDD-vX.Y.Z`\n2. Push tag\n3. Watch ArgoCD\n',
    visibility: 'workspace',
  },
];

const FIXTURE_QUERIES: Array<{ query: string; expectedPageId: string }> = [
  { query: 'auth rotation', expectedPageId: 'pg_decision_auth' },
  { query: 'jwt signing', expectedPageId: 'pg_glossary_jwt' },
  { query: 'security hub', expectedPageId: 'pg_hub_security' },
  { query: 'mysql replicas', expectedPageId: 'pg_decision_db' },
  { query: 'visibility acl', expectedPageId: 'pg_glossary_acl' },
  { query: 'deploy runbook', expectedPageId: 'pg_runbook' },
  { query: 'argocd tag', expectedPageId: 'pg_runbook' },
  { query: 'rs256 token', expectedPageId: 'pg_glossary_jwt' },
  { query: 'workspace agent human task', expectedPageId: 'pg_glossary_acl' },
  { query: 'database choice', expectedPageId: 'pg_decision_db' },
];

async function setup() {
  await prisma.iMUser.createMany({
    data: [
      { id: ownerId, username: `o_${suffix}`, displayName: 'Owner', role: 'human' },
      { id: agent1Id, username: `a1_${suffix}`, displayName: 'Agent 1', role: 'agent' },
    ],
  });
  await prisma.iMWorkspace.create({
    data: { id: ws, ownerImUserId: ownerId, name: 'A', slug: `a_${suffix}`, isDefault: true },
  });
  await prisma.iMAgentCard.create({
    data: { imUserId: agent1Id, name: 'agent1', workspaceId: ws },
  });

  for (const f of FIXTURE_PAGES) {
    await prisma.iMMemoryPage.create({
      data: {
        id: `${f.id}_${suffix}`,
        workspaceId: ws,
        path: f.path,
        title: f.title,
        content: f.content,
        version: 1,
        createdByImUserId: ownerId,
        pageType: f.pageType,
        visibility: f.visibility,
        provenanceJson: '[]',
        encrypted: false,
        contentHash: crypto.createHash('sha256').update(f.content).digest('hex'),
        ...(f.stale ? { stale: true, staleReason: 'archived' } : {}),
      },
    });
  }
  // synthesize inbound links
  const indexId = `pg_index_${suffix}`;
  for (const f of FIXTURE_PAGES) {
    if (!f.inboundLinks) continue;
    for (let i = 0; i < f.inboundLinks; i++) {
      await prisma.iMMemoryLink.create({
        data: {
          workspaceId: ws,
          sourcePageId: indexId,
          targetPageId: `${f.id}_${suffix}`,
          sourceUri: `pkm://INDEX.md#${f.id}-${i}`,
          targetUri: `pkm://${f.path}#anchor-${i}`,
          relation: 'markdown',
          weight: 1,
          broken: false,
        },
      });
    }
  }

  // a memory file (non-page) candidate so /search?kind=both returns files[]
  await prisma.iMMemoryFile.create({
    data: {
      ownerId,
      ownerType: 'user',
      workspaceId: ws,
      path: 'memory/files/cheatsheet.md',
      content: '# CLI cheatsheet\n\nprismer task list\nprismer agent register\n',
      memoryType: 'reference',
      description: 'CLI cheatsheet',
      version: 1,
      visibility: 'workspace',
      encrypted: false,
      contentHash: 'cheatsheet-hash',
      etag: 'cheatsheet-hash',
    },
  });
}

async function ownerAcl() {
  const acl = await loadWorkspaceForMemoryAccess(ws, ownerId, 'user');
  assert.ok(acl);
  return acl!;
}

async function agentAcl() {
  const acl = await loadWorkspaceForMemoryAccess(ws, agent1Id, 'agent');
  assert.ok(acl);
  return acl!;
}

async function main() {
  console.log('[memory-search] setup fixtures');
  await cleanup();
  await setup();

  // ─── visibility filtering on search ────────────────────────
  await runTest('owner sees workspace + human:owner + agent:agent1 in matches', async () => {
    const res = await search.search({
      acl: await ownerAcl(),
      query: 'preferences prefs',
      limit: 50,
    });
    const ids = new Set(res.data.memory.map((r) => r.pageId));
    assert.ok(ids.has(`pg_agent_secret_${suffix}`), 'owner sees agent-private page');
    assert.ok(ids.has(`pg_human_secret_${suffix}`), 'owner sees own human-private page');
  });

  await runTest('agent only sees workspace + agent:self in matches', async () => {
    const res = await search.search({
      acl: await agentAcl(),
      query: 'preferences prefs',
      limit: 50,
    });
    const ids = new Set(res.data.memory.map((r) => r.pageId));
    assert.ok(ids.has(`pg_agent_secret_${suffix}`), 'agent sees own private page');
    assert.ok(!ids.has(`pg_human_secret_${suffix}`), 'agent must not see human-private page');
  });

  // ─── visibility filter ACL intersection (pre-deploy hardening) ─
  // Before the fix, `?visibility=human:<owner>` REPLACED the ACL allow-list
  // and let a delegated agent read the workspace owner's human-private memory.
  // Now the filter must intersect the ACL or 403.
  await runTest('agent cannot bypass ACL by passing visibility=human:<owner>', async () => {
    await assert.rejects(
      search.search({
        acl: await agentAcl(),
        query: 'preferences prefs',
        visibility: `human:${ownerId}`,
        limit: 50,
      }),
      (err: unknown) =>
        err instanceof MemorySearchError && err.code === 'forbidden_visibility_filter' && err.status === 403,
    );
  });

  await runTest('agent cannot bypass ACL by passing visibility=agent:<other>', async () => {
    await assert.rejects(
      search.search({
        acl: await agentAcl(),
        query: 'preferences prefs',
        visibility: 'agent:some-other-agent-id',
        limit: 50,
      }),
      (err: unknown) =>
        err instanceof MemorySearchError && err.code === 'forbidden_visibility_filter' && err.status === 403,
    );
  });

  await runTest('agent CAN filter by their own visibility (agent:self)', async () => {
    const res = await search.search({
      acl: await agentAcl(),
      query: 'preferences prefs',
      visibility: `agent:${agent1Id}`,
      limit: 50,
    });
    // Doesn't throw, all results scoped to agent:<self>.
    for (const m of res.data.memory) {
      assert.equal(m.visibility, `agent:${agent1Id}`);
    }
  });

  await runTest('owner CAN filter by human:<self> (within ACL allow-list)', async () => {
    const res = await search.search({
      acl: await ownerAcl(),
      query: 'preferences prefs',
      visibility: `human:${ownerId}`,
      limit: 50,
    });
    for (const m of res.data.memory) {
      assert.equal(m.visibility, `human:${ownerId}`);
    }
  });

  // ─── encryption modes ─────────────────────────────────────
  await runTest('regulated mode returns empty', async () => {
    const res = await search.search({
      acl: await ownerAcl(),
      query: 'auth rotation',
      encryptionMode: 'regulated',
    });
    assert.equal(res.data.memory.length, 0);
    assert.equal(res.data.files.length, 0);
  });

  await runTest('private mode snippets do not leak content', async () => {
    const res = await search.search({
      acl: await ownerAcl(),
      query: 'compliance',
      encryptionMode: 'private',
    });
    for (const m of res.data.memory) {
      assert.ok(
        !m.snippet.toLowerCase().includes('compliance'),
        `private snippet must not include content match: ${m.snippet}`,
      );
    }
  });

  // ─── ranker boost behaviour ───────────────────────────────
  await runTest('linkBoost lifts highly-cited pages within their cohort', async () => {
    const res = await search.search({
      acl: await ownerAcl(),
      query: 'jwt',
      limit: 5,
    });
    assert.ok(res.data.memory.length > 0);
    const top = res.data.memory[0];
    assert.equal(top.pageId, `pg_glossary_jwt_${suffix}`);
    assert.ok(top.components.linkBoost > 0, 'top result has measurable linkBoost');
  });

  await runTest('stale page gets penalised when included via stale=all', async () => {
    const res = await search.search({
      acl: await ownerAcl(),
      query: 'parser ocr vendor',
      stale: 'all',
      limit: 10,
    });
    const stale = res.data.memory.find((r) => r.pageId === `pg_stale_old_${suffix}`);
    assert.ok(stale, 'stale=all must include stale pages');
    assert.equal(stale!.components.stalePenalty, 0.5);
  });

  // ─── fixture eval ─────────────────────────────────────────
  await runTest('top-3 hit rate ≥ 80% on 10-query fixture', async () => {
    let hits = 0;
    for (const fx of FIXTURE_QUERIES) {
      const res = await search.search({ acl: await ownerAcl(), query: fx.query, limit: 3 });
      const top3 = res.data.memory.slice(0, 3).map((r) => r.pageId);
      const expectedFullId = `${fx.expectedPageId}_${suffix}`;
      if (top3.includes(expectedFullId)) hits++;
      else console.log(`    miss: query="${fx.query}" want=${expectedFullId} got=${top3.join(',')}`);
    }
    const rate = hits / FIXTURE_QUERIES.length;
    console.log(`    fixture top-3 hit: ${hits}/${FIXTURE_QUERIES.length} (${(rate * 100).toFixed(0)}%)`);
    assert.ok(rate >= 0.8, `top-3 hit rate must be ≥ 80%, got ${(rate * 100).toFixed(0)}%`);
  });

  // ─── kind filter ──────────────────────────────────────────
  await runTest('kind=files returns memory file matches only', async () => {
    const res = await search.search({
      acl: await ownerAcl(),
      query: 'cheatsheet',
      kind: 'files',
    });
    assert.ok(res.data.files.length > 0);
    assert.equal(res.data.memory.length, 0);
  });

  // ─── daemon-forwarding stub ───────────────────────────────
  await runTest('daemon-forwarding flag falls back to cloud when daemon offline', async () => {
    process.env.FF_MEMORY_SEARCH_DAEMON_FIRST = 'true';
    try {
      const res = await search.search({
        acl: await ownerAcl(),
        query: 'auth rotation',
        limit: 3,
      });
      assert.ok(res.data.memory.length > 0, 'cloud fallback must answer when daemon offline');
    } finally {
      delete process.env.FF_MEMORY_SEARCH_DAEMON_FIRST;
    }
  });

  console.log(`\n[memory-search] ${passed} passed, ${failed} failed`);
  await cleanup();
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
