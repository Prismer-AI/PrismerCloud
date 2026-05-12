/**
 * MemoryReadService (A2) integration tests against SQLite.
 *
 * Run:
 *   rm -f /tmp/prismer-memory-read.db
 *   DATABASE_URL="file:/tmp/prismer-memory-read.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-memory-read.db" npx tsx src/im/tests/memory-read.test.ts
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import prisma from '../db';
import { _clearMemoryAclCache, loadWorkspaceForMemoryAccess } from '../services/memory-acl';
import { MemoryReadService } from '../services/memory-read.service';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ownerId = `mr_owner_${suffix}`;
const otherOwnerId = `mr_other_${suffix}`;
const agent1Id = `mr_agent1_${suffix}`;
const agent2Id = `mr_agent2_${suffix}`;
const wsA = `mr_ws_a_${suffix}`;
const wsB = `mr_ws_b_${suffix}`;

const pageWorkspace = `mr_pg_workspace_${suffix}`;
const pageAgent1 = `mr_pg_agent1_${suffix}`;
const pageAgent2 = `mr_pg_agent2_${suffix}`;
const pageHumanOwner = `mr_pg_human_${suffix}`;
const pageSecret = `mr_pg_secret_${suffix}`;
const pageTask = `mr_pg_task_${suffix}`;
const pageStale = `mr_pg_stale_${suffix}`;
const pageOrphan = `mr_pg_orphan_${suffix}`;
const pageDup1 = `mr_pg_dup1_${suffix}`;
const pageDup2 = `mr_pg_dup2_${suffix}`;
const pageIndex = `mr_pg_index_${suffix}`;
const pageInWsB = `mr_pg_wsb_${suffix}`;

const sharedHash = crypto.createHash('sha256').update('shared-content').digest('hex');
const ownPath = (s: string) => `memory/${s}.md`;

const service = new MemoryReadService();
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
  await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMMemoryLink.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMMemoryPageVersion.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMKnowledgeLink.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  await prisma.iMAgentCard.deleteMany({ where: { imUserId: { in: [agent1Id, agent2Id] } } });
  await prisma.iMWorkspace.deleteMany({ where: { id: { in: [wsA, wsB] } } });
  await prisma.iMUser.deleteMany({
    where: { id: { in: [ownerId, otherOwnerId, agent1Id, agent2Id] } },
  });
}

function basePage(id: string, workspaceId: string, visibility: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId,
    path: ownPath(id),
    title: id,
    content: `# ${id}\n`,
    version: 1,
    createdByImUserId: ownerId,
    pageType: 'leaf',
    visibility,
    contentHash: crypto.createHash('sha256').update(id).digest('hex'),
    provenanceJson: '[]',
    encrypted: false,
    ...overrides,
  };
}

async function setup() {
  await prisma.iMUser.createMany({
    data: [
      { id: ownerId, username: `o_${suffix}`, displayName: 'Owner', role: 'human' },
      { id: otherOwnerId, username: `oo_${suffix}`, displayName: 'Other', role: 'human' },
      { id: agent1Id, username: `a1_${suffix}`, displayName: 'Agent 1', role: 'agent' },
      { id: agent2Id, username: `a2_${suffix}`, displayName: 'Agent 2', role: 'agent' },
    ],
  });
  await prisma.iMWorkspace.createMany({
    data: [
      { id: wsA, ownerImUserId: ownerId, name: 'A', slug: `a_${suffix}`, isDefault: true },
      { id: wsB, ownerImUserId: otherOwnerId, name: 'B', slug: `b_${suffix}`, isDefault: true },
    ],
  });
  await prisma.iMAgentCard.createMany({
    data: [
      { imUserId: agent1Id, name: 'agent1', workspaceId: wsA },
      { imUserId: agent2Id, name: 'agent2', workspaceId: wsA },
    ],
  });

  // Pages with the full visibility matrix
  await prisma.iMMemoryPage.createMany({
    data: [
      basePage(pageWorkspace, wsA, 'workspace'),
      basePage(pageAgent1, wsA, `agent:${agent1Id}`),
      basePage(pageAgent2, wsA, `agent:${agent2Id}`),
      basePage(pageHumanOwner, wsA, `human:${ownerId}`),
      basePage(pageSecret, wsA, 'secret-ref'),
      basePage(pageTask, wsA, 'task:tk_demo_xyz'),
      basePage(pageStale, wsA, 'workspace', { stale: true, staleReason: 'source-archived' }),
      basePage(pageOrphan, wsA, 'workspace'),
      basePage(pageDup1, wsA, 'workspace', { contentHash: sharedHash, pageType: 'leaf' }),
      basePage(pageDup2, wsA, 'workspace', { contentHash: sharedHash, pageType: 'leaf' }),
      basePage(pageIndex, wsA, 'workspace', { path: 'INDEX.md' }),
      basePage(pageInWsB, wsB, 'workspace'),
    ],
  });

  // Outbound link: workspace page → orphan page
  // (this means the orphan is NOT actually an orphan because it has 1 inbound link;
  //  we'll add a *real* orphan via pageOrphan having NO inbound links — already true.)
  await prisma.iMMemoryLink.create({
    data: {
      workspaceId: wsA,
      sourcePageId: pageWorkspace,
      targetPageId: pageAgent1,
      sourceUri: `pkm://${ownPath(pageWorkspace)}`,
      targetUri: `pkm://${ownPath(pageAgent1)}`,
      relation: 'markdown',
      weight: 1,
      broken: false,
    },
  });
  // Broken outbound from workspace page
  await prisma.iMMemoryLink.create({
    data: {
      workspaceId: wsA,
      sourcePageId: pageWorkspace,
      targetPageId: null,
      sourceUri: `pkm://${ownPath(pageWorkspace)}`,
      targetUri: 'pkm://memory/missing.md',
      relation: 'markdown',
      weight: 1,
      broken: true,
    },
  });

  // Page versions for pageWorkspace
  await prisma.iMMemoryPageVersion.create({
    data: {
      workspaceId: wsA,
      pageId: pageWorkspace,
      version: 1,
      content: `# ${pageWorkspace}\n`,
      contentHash: crypto.createHash('sha256').update(pageWorkspace).digest('hex'),
      createdByImUserId: ownerId,
      changeSummary: 'initial',
      encrypted: false,
    },
  });

  // Observability events keyed by sessionId
  const sessionId = `sess_${suffix}`;
  await prisma.iMMemoryObservabilityEvent.createMany({
    data: [
      {
        workspaceId: wsA,
        eventType: 'recall_inject',
        actorImUserId: agent1Id,
        actorKind: 'agent',
        pageId: pageWorkspace,
        query: 'how does memory work',
        metricsJson: JSON.stringify({ tokenCount: 150, relevanceScore: 0.82 }),
        metadataJson: JSON.stringify({ sessionId, conversationId: 'cv_x' }),
      },
      {
        workspaceId: wsA,
        eventType: 'feedback',
        actorImUserId: ownerId,
        actorKind: 'user',
        pageId: pageWorkspace,
        metadataJson: JSON.stringify({ sessionId, signal: 1 }),
      },
      {
        // unrelated session — must not appear in trace
        workspaceId: wsA,
        eventType: 'recall_inject',
        actorImUserId: agent1Id,
        actorKind: 'agent',
        pageId: pageWorkspace,
        metadataJson: JSON.stringify({ sessionId: 'sess_other' }),
      },
    ],
  });

  return { sessionId };
}

async function main() {
  console.log('[memory-read] setup fixtures');
  await cleanup();
  const { sessionId } = await setup();

  // ────────────────────────────────────────────────
  // Owner human view
  // ────────────────────────────────────────────────
  await runTest('owner sees workspace/human/agent1/agent2/task pages, hides secret-ref', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    assert.ok(acl);
    const pages = await service.listPages(acl!, { limit: 200 });
    const ids = new Set(pages.map((p) => p.id));
    assert.ok(ids.has(pageWorkspace));
    assert.ok(ids.has(pageAgent1));
    assert.ok(ids.has(pageAgent2));
    assert.ok(ids.has(pageHumanOwner));
    assert.ok(ids.has(pageTask));
    assert.ok(!ids.has(pageSecret), 'secret-ref must be hidden');
    assert.ok(!ids.has(pageInWsB), 'cross-workspace must be hidden');
  });

  await runTest('summary enrichment: inboundLinkCount/outboundLinkCount populated', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const pages = await service.listPages(acl!, { limit: 200 });
    const wsPage = pages.find((p) => p.id === pageWorkspace)!;
    const agent1Page = pages.find((p) => p.id === pageAgent1)!;
    assert.equal(wsPage.outboundLinkCount, 2, 'pageWorkspace has 2 outbound (1 valid + 1 broken)');
    assert.equal(agent1Page.inboundLinkCount, 1, 'agent1 page has 1 inbound from pageWorkspace');
  });

  // ────────────────────────────────────────────────
  // Delegated agent view
  // ────────────────────────────────────────────────
  await runTest('delegated agent sees only workspace + agent:self pages', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, agent1Id, 'agent');
    assert.ok(acl);
    const pages = await service.listPages(acl!, { limit: 200 });
    const ids = new Set(pages.map((p) => p.id));
    assert.ok(ids.has(pageWorkspace));
    assert.ok(ids.has(pageAgent1));
    assert.ok(!ids.has(pageAgent2), 'agent1 must not see agent2 pages');
    assert.ok(!ids.has(pageHumanOwner));
    assert.ok(!ids.has(pageTask));
    assert.ok(!ids.has(pageSecret));
  });

  // ────────────────────────────────────────────────
  // by-source
  // ────────────────────────────────────────────────
  await runTest('listBySource returns empty for unmatched sourceRef', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const pages = await service.listBySource(acl!, { sourceRef: 'asset://nonexistent', sourceAssetId: null });
    assert.equal(pages.length, 0);
  });

  // ────────────────────────────────────────────────
  // Page links
  // ────────────────────────────────────────────────
  await runTest('getPageLinks returns outbound + backlinks scoped to workspace', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const links = await service.getPageLinks(acl!, pageWorkspace);
    assert.ok(links);
    assert.equal(links!.outbound.length, 2);
    assert.equal(links!.backlinks.length, 0);
    assert.equal(links!.knowledge.length, 0);
  });

  await runTest('getPageLinks returns null for unauthorized caller', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, agent1Id, 'agent');
    // agent1 cannot read agent2 page
    const links = await service.getPageLinks(acl!, pageAgent2);
    assert.equal(links, null);
  });

  // ────────────────────────────────────────────────
  // Versions
  // ────────────────────────────────────────────────
  await runTest('listVersions returns version chain', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const versions = await service.listVersions(acl!, pageWorkspace);
    assert.ok(versions);
    assert.equal(versions!.length, 1);
    assert.equal(versions![0].version, 1);
    assert.equal(versions![0].changeSummary, 'initial');
  });

  // ────────────────────────────────────────────────
  // Health
  // ────────────────────────────────────────────────
  await runTest('healthBrokenLinks lists broken outbound from visible source', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const data = await service.healthBrokenLinks(acl!);
    assert.equal(data.items.length, 1);
    assert.match(data.items[0].reason, /^broken_link:pkm:\/\/memory\/missing\.md$/);
  });

  await runTest('healthStale lists stale workspace pages', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const data = await service.healthStale(acl!);
    const ids = data.items.map((it) => it.pageId);
    assert.ok(ids.includes(pageStale));
  });

  await runTest('healthDuplicates returns cluster of pageDup1+pageDup2', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const data = await service.healthDuplicates(acl!);
    const ids = new Set(data.items.map((it) => it.pageId));
    assert.ok(ids.has(pageDup1));
    assert.ok(ids.has(pageDup2));
    assert.equal(data.items.length, 2);
    const item = data.items[0];
    assert.match(item.reason, /^duplicate_cluster:/);
    assert.equal((item.metadata as { clusterSize: number }).clusterSize, 2);
  });

  await runTest('healthOrphans flags pages with no inbound and not on INDEX path', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const data = await service.healthOrphans(acl!);
    const ids = new Set(data.items.map((it) => it.pageId));
    assert.ok(ids.has(pageOrphan), 'pageOrphan has no inbound, must appear');
    assert.ok(!ids.has(pageAgent1), 'pageAgent1 has inbound from pageWorkspace, must not appear');
  });

  // ────────────────────────────────────────────────
  // Graph
  // ────────────────────────────────────────────────
  await runTest('graph from pageWorkspace expands BFS depth=1', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const data = await service.graph(acl!, pageWorkspace, 1);
    assert.ok(data);
    const nodeIds = new Set(data!.nodes.map((n) => n.pageId));
    assert.ok(nodeIds.has(pageWorkspace));
    assert.ok(nodeIds.has(pageAgent1));
    // de-duped edges, only the valid (non-broken) edge survives the filter
    // (broken edge has targetPageId === null, doesn't enter the BFS frontier
    // and is included only with both endpoints visible)
    assert.ok(data!.edges.length >= 1);
  });

  await runTest('graph returns null for non-existent root', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const data = await service.graph(acl!, 'nonexistent', 2);
    assert.equal(data, null);
  });

  // ────────────────────────────────────────────────
  // Recall trace
  // ────────────────────────────────────────────────
  await runTest('recallTrace filters by sessionId in metadataJson', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const data = await service.recallTrace(acl!, sessionId);
    assert.equal(data.events.length, 2);
    const types = data.events.map((e) => e.eventType);
    assert.ok(types.includes('recall_inject'));
    assert.ok(types.includes('feedback'));
  });

  await runTest('recallTrace returns empty for unknown session', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsA, ownerId, 'user');
    const data = await service.recallTrace(acl!, 'sess_no_such_thing');
    assert.equal(data.events.length, 0);
  });

  // ────────────────────────────────────────────────
  // Cross-workspace ACL
  // ────────────────────────────────────────────────
  await runTest('cross-workspace owner cannot see B pages via listPages', async () => {
    const acl = await loadWorkspaceForMemoryAccess(wsB, ownerId, 'user');
    assert.equal(acl, null);
  });

  console.log(`\n[memory-read] ${passed} passed, ${failed} failed`);
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
