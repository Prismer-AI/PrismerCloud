/**
 * loadWorkspaceForMemoryAccess unit tests.
 *
 * Run:
 *   DATABASE_URL="file:/tmp/prismer-memory-acl.db" npx prisma db push --schema prisma/schema.prisma --skip-generate
 *   DATABASE_URL="file:/tmp/prismer-memory-acl.db" npx tsx src/im/tests/memory-acl.test.ts
 */

import assert from 'node:assert/strict';
import prisma from '../db';
import { _clearMemoryAclCache, _memoryAclCacheSize, loadWorkspaceForMemoryAccess } from '../services/memory-acl';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ownerId = `acl_owner_${suffix}`;
const otherOwnerId = `acl_other_${suffix}`;
const agent1Id = `acl_agent1_${suffix}`;
const agent2Id = `acl_agent2_${suffix}`;
const otherAgentId = `acl_other_agent_${suffix}`;
const workspaceA = `acl_ws_a_${suffix}`;
const workspaceB = `acl_ws_b_${suffix}`;

async function setup() {
  await prisma.iMUser.createMany({
    data: [
      { id: ownerId, username: `owner_${suffix}`, displayName: 'Owner', role: 'human' },
      { id: otherOwnerId, username: `other_${suffix}`, displayName: 'Other', role: 'human' },
      { id: agent1Id, username: `agent1_${suffix}`, displayName: 'Agent 1', role: 'agent' },
      { id: agent2Id, username: `agent2_${suffix}`, displayName: 'Agent 2', role: 'agent' },
      { id: otherAgentId, username: `other_agent_${suffix}`, displayName: 'Other Agent', role: 'agent' },
    ],
  });

  await prisma.iMWorkspace.createMany({
    data: [
      { id: workspaceA, ownerImUserId: ownerId, name: 'A', slug: `a_${suffix}`, isDefault: true },
      { id: workspaceB, ownerImUserId: otherOwnerId, name: 'B', slug: `b_${suffix}`, isDefault: true },
    ],
  });

  await prisma.iMAgentCard.createMany({
    data: [
      { imUserId: agent1Id, name: 'agent1', workspaceId: workspaceA },
      { imUserId: agent2Id, name: 'agent2', workspaceId: workspaceA },
      { imUserId: otherAgentId, name: 'other_agent', workspaceId: workspaceB },
    ],
  });
}

async function cleanup() {
  await prisma.iMAgentCard.deleteMany({
    where: { imUserId: { in: [agent1Id, agent2Id, otherAgentId] } },
  });
  await prisma.iMWorkspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB] } } });
  await prisma.iMUser.deleteMany({
    where: { id: { in: [ownerId, otherOwnerId, agent1Id, agent2Id, otherAgentId] } },
  });
}

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

async function main() {
  console.log('[memory-acl] setup fixtures');
  await cleanup();
  await setup();

  // ─────────────────────────────────────────────────────────────
  // Scenario 1: owner human resolves with full visibility set
  // ─────────────────────────────────────────────────────────────
  await runTest('owner human gets workspace + human:self + agent:* + task: prefix', async () => {
    const ctx = await loadWorkspaceForMemoryAccess(workspaceA, ownerId, 'user');
    assert.ok(ctx, 'owner must get a context');
    assert.equal(ctx!.callerKind, 'user');
    assert.equal(ctx!.workspaceId, workspaceA);
    assert.deepEqual(
      [...ctx!.allowedVisibilities].sort(),
      ['workspace', `human:${ownerId}`, `agent:${agent1Id}`, `agent:${agent2Id}`].sort(),
    );
    assert.deepEqual(ctx!.allowedVisibilityPrefixes, ['task:']);
    assert.equal(ctx!.canRead({ visibility: 'workspace' }), true);
    assert.equal(ctx!.canRead({ visibility: `human:${ownerId}` }), true);
    assert.equal(ctx!.canRead({ visibility: `agent:${agent1Id}` }), true);
    assert.equal(ctx!.canRead({ visibility: `agent:${agent2Id}` }), true);
    assert.equal(ctx!.canRead({ visibility: 'task:tk_abc123' }), true);
    assert.equal(ctx!.canRead({ visibility: `agent:${otherAgentId}` }), false);
    assert.equal(ctx!.canRead({ visibility: 'human:somebody-else' }), false);
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 2: delegated agent gets workspace + agent:self only
  // ─────────────────────────────────────────────────────────────
  await runTest('delegated agent gets workspace + agent:self only', async () => {
    const ctx = await loadWorkspaceForMemoryAccess(workspaceA, agent1Id, 'agent');
    assert.ok(ctx, 'delegated agent must get a context');
    assert.equal(ctx!.callerKind, 'agent');
    assert.deepEqual(ctx!.allowedVisibilities.sort(), ['workspace', `agent:${agent1Id}`].sort());
    assert.deepEqual(ctx!.allowedVisibilityPrefixes, []);
    assert.equal(ctx!.canRead({ visibility: 'workspace' }), true);
    assert.equal(ctx!.canRead({ visibility: `agent:${agent1Id}` }), true);
    assert.equal(ctx!.canRead({ visibility: `agent:${agent2Id}` }), false);
    assert.equal(ctx!.canRead({ visibility: `human:${ownerId}` }), false);
    assert.equal(ctx!.canRead({ visibility: 'task:tk_abc' }), false);
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 3: owner with N agents — list grows with delegation
  // ─────────────────────────────────────────────────────────────
  await runTest('owner sees every delegated agent imUserId', async () => {
    const ctx = await loadWorkspaceForMemoryAccess(workspaceA, ownerId, 'user');
    const agentVisibilities = ctx!.allowedVisibilities.filter((v) => v.startsWith('agent:'));
    assert.equal(agentVisibilities.length, 2, 'two delegated agents in workspace A');
    assert.ok(agentVisibilities.includes(`agent:${agent1Id}`));
    assert.ok(agentVisibilities.includes(`agent:${agent2Id}`));
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 4: cross-workspace access denied
  // ─────────────────────────────────────────────────────────────
  await runTest('cross-workspace owner returns null', async () => {
    const ctx = await loadWorkspaceForMemoryAccess(workspaceB, ownerId, 'user');
    assert.equal(ctx, null, 'owner of A cannot access B');
  });

  await runTest('cross-workspace agent returns null', async () => {
    const ctx = await loadWorkspaceForMemoryAccess(workspaceB, agent1Id, 'agent');
    assert.equal(ctx, null, 'agent of A cannot access B');
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 5: null / empty caller is rejected
  // ─────────────────────────────────────────────────────────────
  await runTest('empty callerImUserId returns null', async () => {
    const a = await loadWorkspaceForMemoryAccess(workspaceA, '', 'user');
    const b = await loadWorkspaceForMemoryAccess('', ownerId, 'user');
    assert.equal(a, null);
    assert.equal(b, null);
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 6: secret-ref visibility is unconditionally denied
  // ─────────────────────────────────────────────────────────────
  await runTest('secret-ref denied for owner human', async () => {
    const ctx = await loadWorkspaceForMemoryAccess(workspaceA, ownerId, 'user');
    assert.equal(ctx!.canRead({ visibility: 'secret-ref' }), false);
    assert.equal(ctx!.canWrite({ visibility: 'secret-ref' }), false);
  });

  await runTest('secret-ref denied for delegated agent', async () => {
    const ctx = await loadWorkspaceForMemoryAccess(workspaceA, agent1Id, 'agent');
    assert.equal(ctx!.canRead({ visibility: 'secret-ref' }), false);
    assert.equal(ctx!.canWrite({ visibility: 'secret-ref' }), false);
  });

  // ─────────────────────────────────────────────────────────────
  // Cache behavior — warm path returns the same context object
  // ─────────────────────────────────────────────────────────────
  await runTest('warm cache hit returns identical context', async () => {
    const a = await loadWorkspaceForMemoryAccess(workspaceA, ownerId, 'user');
    const b = await loadWorkspaceForMemoryAccess(workspaceA, ownerId, 'user');
    assert.equal(a, b, 'second call must return the cached context object');
    assert.ok(_memoryAclCacheSize() >= 1);
  });

  // ─────────────────────────────────────────────────────────────
  // Performance smoke — warm path under 5ms (best effort)
  // ─────────────────────────────────────────────────────────────
  await runTest('warm path under 5ms (smoke)', async () => {
    await loadWorkspaceForMemoryAccess(workspaceA, ownerId, 'user');
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      await loadWorkspaceForMemoryAccess(workspaceA, ownerId, 'user');
    }
    const avg = (performance.now() - start) / 100;
    console.log(`    warm avg: ${avg.toFixed(3)}ms`);
    assert.ok(avg < 5, `warm avg should stay under 5ms, got ${avg}ms`);
  });

  console.log(`\n[memory-acl] ${passed} passed, ${failed} failed`);
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
