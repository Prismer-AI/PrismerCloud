/**
 * M-C — memory-page-dream.service.ts unit tests.
 *
 * Exercises the three IMMemoryPage invariants:
 *   1. Top-INDEX size invariant — counts top-level hub/index pages,
 *      reports clusters when threshold exceeded.
 *   2. Garbage page pruning — old + no inbound + no recent obs → stale +
 *      proposal. CRITICAL: must NOT touch user-actively-recalled pages.
 *   3. Frontier materialization — clusters of N+ pages with K+ recalls
 *      surfaced as candidates for hub generation.
 *
 * Run:
 *   rm -f /tmp/prismer-page-dream.db
 *   DATABASE_URL="file:/tmp/prismer-page-dream.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-page-dream.db" \
 *     npx tsx src/im/tests/memory-page-dream.test.ts
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import prisma from '../db';
import {
  enforceTopIndexInvariant,
  findFrontierCandidates,
  pruneGarbagePages,
  runPageDream,
  TOP_INDEX_THRESHOLD,
  GARBAGE_AGE_MS,
  FRONTIER_MIN_PAGES,
  FRONTIER_MIN_RECALLS,
} from '../services/memory-page-dream.service';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ownerId = `pd_owner_${suffix}`;
const wsA = `pd_ws_a_${suffix}`;

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
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
  await prisma.iMMemoryProposal.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMMemoryLink.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMMemoryPageVersion.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMWorkspace.deleteMany({ where: { id: wsA } });
  await prisma.iMUser.deleteMany({ where: { id: ownerId } });
}

async function setup() {
  await prisma.iMUser.create({
    data: { id: ownerId, username: `o_${suffix}`, displayName: 'Owner', role: 'human' },
  });
  await prisma.iMWorkspace.create({
    data: { id: wsA, ownerImUserId: ownerId, name: 'A', slug: `a_${suffix}`, isDefault: true },
  });
}

function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function makePage(opts: {
  path: string;
  pageType?: string;
  sourceKind?: string | null;
  sourceRef?: string | null;
  sourceAssetId?: string | null;
  agedDays?: number; // override updatedAt
  stale?: boolean;
}) {
  const updatedAt = opts.agedDays ? new Date(Date.now() - opts.agedDays * 24 * 60 * 60 * 1000) : new Date();
  const created = await prisma.iMMemoryPage.create({
    data: {
      workspaceId: wsA,
      path: opts.path,
      title: opts.path,
      content: `body of ${opts.path}`,
      version: 1,
      createdByImUserId: ownerId,
      pageType: opts.pageType ?? 'hub',
      sourceKind: opts.sourceKind ?? null,
      sourceRef: opts.sourceRef ?? null,
      sourceAssetId: opts.sourceAssetId ?? null,
      provenanceJson: '[]',
      visibility: 'workspace',
      contentHash: hash(`body of ${opts.path}`),
      stale: opts.stale ?? false,
    },
  });
  if (opts.agedDays) {
    await prisma.iMMemoryPage.update({ where: { id: created.id }, data: { updatedAt } });
  }
  return created;
}

async function main() {
  console.log('[memory-page-dream] setup');
  await cleanup();
  await setup();

  // ─── enforceTopIndexInvariant ─────────────────────────────────────
  await runTest('top-INDEX invariant: count below threshold returns breached=false', async () => {
    await makePage({ path: 'a.md', pageType: 'hub' });
    await makePage({ path: 'b.md', pageType: 'hub' });
    const r = await enforceTopIndexInvariant(wsA);
    assert.equal(r.breached, false);
    assert.equal(r.topIndexCount, 2);
    assert.deepEqual(r.clusterCandidates, []);
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  await runTest('top-INDEX invariant: count above threshold groups clusters by (pageType, sourceKind)', async () => {
    // Synthesize > TOP_INDEX_THRESHOLD pages spread across 2 clusters.
    const totalToCreate = TOP_INDEX_THRESHOLD + 5;
    const halfA = Math.floor(totalToCreate / 2);
    for (let i = 0; i < halfA; i++) {
      await makePage({ path: `a${i}.md`, pageType: 'hub', sourceKind: 'asset-hook' });
    }
    for (let i = halfA; i < totalToCreate; i++) {
      await makePage({ path: `b${i}.md`, pageType: 'hub', sourceKind: null });
    }
    const r = await enforceTopIndexInvariant(wsA);
    assert.equal(r.breached, true);
    assert.ok(r.topIndexCount > TOP_INDEX_THRESHOLD);
    // Two clusters expected (different sourceKind values).
    assert.ok(r.clusterCandidates.length >= 1);
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  // ─── pruneGarbagePages ────────────────────────────────────────────
  await runTest('garbage prune: old + no inbound + no recent obs → stale + proposal', async () => {
    await makePage({ path: 'old-page.md', pageType: 'leaf', agedDays: 100 });
    const r = await pruneGarbagePages(wsA, ownerId);
    assert.equal(r.markedStale, 1);
    assert.equal(r.proposalsWritten, 1);
    const proposal = await prisma.iMMemoryProposal.findFirst({
      where: { workspaceId: wsA, pagePath: 'old-page.md' },
    });
    assert.ok(proposal);
    assert.equal(proposal!.operation, 'delete');
    const page = await prisma.iMMemoryPage.findFirstOrThrow({
      where: { workspaceId: wsA, path: 'old-page.md' },
    });
    assert.equal(page.stale, true);
    await prisma.iMMemoryProposal.deleteMany({ where: { workspaceId: wsA } });
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  await runTest('garbage prune: page with recent recall_pull is SKIPPED', async () => {
    const old = await makePage({ path: 'recall-protected.md', pageType: 'leaf', agedDays: 100 });
    // Add a recent recall_pull → page should NOT be pruned.
    await prisma.iMMemoryObservabilityEvent.create({
      data: {
        workspaceId: wsA,
        eventType: 'recall_pull',
        actorImUserId: ownerId,
        actorKind: 'agent',
        pageId: old.id,
        createdAt: new Date(),
      },
    });
    const r = await pruneGarbagePages(wsA, ownerId);
    assert.equal(r.markedStale, 0);
    assert.equal(r.proposalsWritten, 0);
    await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: wsA } });
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  await runTest('garbage prune: page with inbound link is SKIPPED', async () => {
    const target = await makePage({ path: 'linked.md', pageType: 'leaf', agedDays: 100 });
    const source = await makePage({ path: 'has-link.md', pageType: 'hub', agedDays: 100 });
    await prisma.iMMemoryLink.create({
      data: {
        workspaceId: wsA,
        sourcePageId: source.id,
        targetPageId: target.id,
        sourceUri: `prismer://workspace/${wsA}/memory/has-link.md`,
        targetUri: `prismer://workspace/${wsA}/memory/linked.md`,
        relation: 'references',
        weight: 1,
        broken: false,
      },
    });
    const r = await pruneGarbagePages(wsA, ownerId);
    // Note: source page may itself be pruned (no inbound), but target with
    // inbound link must NOT be.
    const stillFresh = await prisma.iMMemoryPage.findFirstOrThrow({
      where: { id: target.id },
    });
    assert.equal(stillFresh.stale, false, 'page with inbound link must not be marked stale');
    assert.ok(!r.pageIds.includes(target.id), 'target should not appear in pruned ids');
    await prisma.iMMemoryLink.deleteMany({ where: { workspaceId: wsA } });
    await prisma.iMMemoryProposal.deleteMany({ where: { workspaceId: wsA } });
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  await runTest('garbage prune: idempotent — re-running on same workspace produces 0 marks', async () => {
    await makePage({ path: 'old1.md', pageType: 'leaf', agedDays: 100 });
    await makePage({ path: 'old2.md', pageType: 'leaf', agedDays: 100 });
    const first = await pruneGarbagePages(wsA, ownerId);
    assert.equal(first.markedStale, 2);
    const second = await pruneGarbagePages(wsA, ownerId);
    assert.equal(second.markedStale, 0, 'already-stale pages should be skipped');
    await prisma.iMMemoryProposal.deleteMany({ where: { workspaceId: wsA } });
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  // ─── findFrontierCandidates ───────────────────────────────────────
  await runTest('frontier: no candidates when below page-count threshold', async () => {
    const p1 = await makePage({ path: 'sparse1.md', sourceRef: 'asset://x' });
    await prisma.iMMemoryObservabilityEvent.create({
      data: {
        workspaceId: wsA,
        eventType: 'recall_pull',
        actorImUserId: ownerId,
        actorKind: 'agent',
        pageId: p1.id,
      },
    });
    const r = await findFrontierCandidates(wsA);
    assert.deepEqual(r.candidates, []);
    await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: wsA } });
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  await runTest('frontier: cluster of N+ pages on same sourceRef with K+ pulls → candidate', async () => {
    const sharedRef = 'asset://shared';
    const ids: string[] = [];
    for (let i = 0; i < FRONTIER_MIN_PAGES + 1; i++) {
      const p = await makePage({ path: `cluster${i}.md`, sourceRef: sharedRef });
      ids.push(p.id);
    }
    for (let i = 0; i < FRONTIER_MIN_RECALLS; i++) {
      await prisma.iMMemoryObservabilityEvent.create({
        data: {
          workspaceId: wsA,
          eventType: 'recall_pull',
          actorImUserId: ownerId,
          actorKind: 'agent',
          pageId: ids[i % ids.length]!,
        },
      });
    }
    const r = await findFrontierCandidates(wsA);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]!.sourceRef, sharedRef);
    assert.ok(r.candidates[0]!.pageCount >= FRONTIER_MIN_PAGES);
    await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: wsA } });
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  // ─── runPageDream (orchestration) ─────────────────────────────────
  await runTest('runPageDream returns all three invariant results', async () => {
    await makePage({ path: 'orch1.md', pageType: 'leaf', agedDays: 100 });
    const r = await runPageDream(wsA, ownerId);
    assert.ok(r.topIndex);
    assert.ok(r.garbage);
    assert.ok(r.frontier);
    assert.ok(r.durationMs >= 0);
    assert.equal(r.garbage.markedStale, 1);
    await prisma.iMMemoryProposal.deleteMany({ where: { workspaceId: wsA } });
    await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: wsA } });
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  await cleanup();
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
