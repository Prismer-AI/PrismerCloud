/**
 * M-F memory metrics aggregator tests.
 *
 * Seeds observability events + proposals into a fresh SQLite, then
 * asserts each of the 7 doc 25 §5.5 metrics computes the right value
 * and the right threshold pass/fail verdict.
 *
 * Run:
 *   rm -f /tmp/prismer-memory-metrics.db
 *   DATABASE_URL="file:/tmp/prismer-memory-metrics.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-memory-metrics.db" \
 *     npx tsx src/im/tests/memory-metrics.test.ts
 */

import assert from 'node:assert/strict';
import prisma from '../db';
import { computeMemoryMetrics, DEFAULT_THRESHOLDS } from '../services/memory-metrics.service';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ownerId = `mm_owner_${suffix}`;
const wsA = `mm_ws_a_${suffix}`;

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

async function emit(eventType: string, metadata: Record<string, unknown> = {}, metrics: Record<string, unknown> = {}) {
  await prisma.iMMemoryObservabilityEvent.create({
    data: {
      workspaceId: wsA,
      eventType,
      actorImUserId: ownerId,
      actorKind: 'agent',
      metadataJson: JSON.stringify(metadata),
      metricsJson: JSON.stringify(metrics),
    },
  });
}

async function clearEvents() {
  await prisma.iMMemoryProposal.deleteMany({ where: { workspaceId: wsA } });
  await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: wsA } });
}

async function main() {
  console.log('[memory-metrics] setup');
  await cleanup();
  await setup();

  await runTest('empty workspace: all metrics null, allGreen=true (no failing samples)', async () => {
    const r = await computeMemoryMetrics(wsA);
    assert.equal(r.metrics.recallPullPerTurn.value, null);
    assert.equal(r.metrics.recallEmptyRate.value, null);
    assert.equal(r.overall.allGreen, true);
  });

  await runTest('recall_pull/turn ratio computes from distinct sessionId+turnIndex', async () => {
    await clearEvents();
    // 4 turns across 2 sessions, with 1 recall_pull each → ratio = 4/4 = 1.0 (fails 0.3 threshold).
    for (const sessionId of ['s1', 's2']) {
      for (const turnIndex of [0, 1]) {
        await emit('recall_pull', { sessionId, turnIndex });
      }
    }
    const r = await computeMemoryMetrics(wsA);
    assert.equal(r.metrics.recallPullPerTurn.value, 1.0);
    assert.equal(r.metrics.recallPullPerTurn.passing, false);
    assert.equal(r.metrics.recallPullPerTurn.threshold, DEFAULT_THRESHOLDS.recallPullPerTurnMax);
  });

  await runTest('recall empty_rate from recall_fork.selectedCount = 0', async () => {
    await clearEvents();
    await emit('recall_fork', { selectedCount: 0 }, { durationMs: 200 });
    await emit('recall_fork', { selectedCount: 2 }, { durationMs: 300 });
    await emit('recall_fork', { selectedCount: 0 }, { durationMs: 250 });
    const r = await computeMemoryMetrics(wsA);
    assert.ok(r.metrics.recallEmptyRate.value !== null);
    assert.ok(Math.abs(r.metrics.recallEmptyRate.value! - 2 / 3) < 0.001);
  });

  await runTest('recall p95 latency from recall_fork.durationMs', async () => {
    await clearEvents();
    for (const dur of [100, 200, 300, 1200, 5000]) {
      await emit('recall_fork', { selectedCount: 1 }, { durationMs: dur });
    }
    const r = await computeMemoryMetrics(wsA);
    // p95 of 5 values is the index ceil(0.95*5)-1 = 4 → 5000.
    assert.equal(r.metrics.recallP95LatencyMs.value, 5000);
    assert.equal(r.metrics.recallP95LatencyMs.passing, false);
  });

  await runTest('recall_inject token-per-turn p95 sums tokens grouped by sessionId+turnIndex', async () => {
    await clearEvents();
    await emit('recall_inject', { sessionId: 's1', turnIndex: 0 }, { tokenCount: 100 });
    await emit('recall_inject', { sessionId: 's1', turnIndex: 0 }, { tokenCount: 200 });
    await emit('recall_inject', { sessionId: 's1', turnIndex: 1 }, { tokenCount: 50 });
    const r = await computeMemoryMetrics(wsA);
    // Two distinct turns. Tokens: turn 0 = 300, turn 1 = 50. p95 of [50, 300] is 300.
    assert.equal(r.metrics.recallInjectTokenPerTurnP95.value, 300);
  });

  await runTest('extract proposal accept rate from im_memory_proposals.status', async () => {
    await clearEvents();
    for (const status of ['approved', 'approved', 'rejected', 'pending']) {
      await prisma.iMMemoryProposal.create({
        data: {
          workspaceId: wsA,
          proposingAgentId: ownerId,
          status,
          pagePath: `memory/p-${status}-${Math.random()}.md`,
          baseVersion: 0,
          operation: 'create',
          contentDiff: 'x',
          confidence: 0.7,
          sourceRefs: '[]',
          expiresAt: new Date(Date.now() + 1_000_000),
        },
      });
    }
    const r = await computeMemoryMetrics(wsA);
    assert.ok(Math.abs(r.metrics.extractProposalAcceptRate.value! - 2 / 4) < 0.001);
  });

  await runTest('fork prompt-cache hit rate from recall_fork.cacheRead/CreationTokens', async () => {
    await clearEvents();
    await emit(
      'recall_fork',
      { selectedCount: 1 },
      { durationMs: 100, cacheReadTokens: 800, cacheCreationTokens: 0, inputTokens: 200 },
    );
    await emit(
      'recall_fork',
      { selectedCount: 1 },
      { durationMs: 100, cacheReadTokens: 0, cacheCreationTokens: 600, inputTokens: 400 },
    );
    const r = await computeMemoryMetrics(wsA);
    // total cacheable = (800+0+200) + (0+600+400) = 1000+1000 = 2000.
    // hits = 800 + 0 = 800 → 800/2000 = 0.4. Fails the 0.7 threshold.
    assert.ok(Math.abs(r.metrics.forkPromptCacheHitRate.value! - 0.4) < 0.001);
    assert.equal(r.metrics.forkPromptCacheHitRate.passing, false);
  });

  await runTest('overall.allGreen=false when any metric with a value fails', async () => {
    await clearEvents();
    // Two recall_pull events with one turn => ratio = 2.0 (fails threshold).
    await emit('recall_pull', { sessionId: 's1', turnIndex: 0 });
    await emit('recall_pull', { sessionId: 's1', turnIndex: 0 });
    const r = await computeMemoryMetrics(wsA);
    assert.equal(r.overall.allGreen, false);
    assert.ok(r.overall.failingCount >= 1);
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
