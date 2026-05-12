/**
 * MemoryProposalService (A4) integration tests against SQLite.
 *
 * Run:
 *   rm -f /tmp/prismer-memory-prop.db
 *   DATABASE_URL="file:/tmp/prismer-memory-prop.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss
 *   DATABASE_URL="file:/tmp/prismer-memory-prop.db" npx tsx src/im/tests/memory-proposal.test.ts
 */

import assert from 'node:assert/strict';
import prisma from '../db';
import { _clearMemoryAclCache, loadWorkspaceForMemoryAccess } from '../services/memory-acl';
import { MemoryWriteError, MemoryWriteService } from '../services/memory-write.service';
import { MemoryProposalService } from '../services/memory-proposal.service';

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ownerId = `mp_owner_${suffix}`;
const agent1Id = `mp_agent1_${suffix}`;
const ws = `mp_ws_${suffix}`;

const writer = new MemoryWriteService();
const proposals = new MemoryProposalService();
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
  await prisma.iMMemoryProposal.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMMemoryObservabilityEvent.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMMemoryLink.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMMemoryPageVersion.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMMemoryPage.deleteMany({ where: { workspaceId: ws } });
  await prisma.iMAgentCard.deleteMany({ where: { imUserId: agent1Id } });
  await prisma.iMWorkspace.deleteMany({ where: { id: ws } });
  await prisma.iMUser.deleteMany({ where: { id: { in: [ownerId, agent1Id] } } });
}

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
  console.log('[memory-proposal] setup fixtures');
  await cleanup();
  await setup();

  // ─── create ───────────────────────────────────────────────
  await runTest('create — agent valid input writes proposal', async () => {
    const proposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: 'memory/p/note.md',
      baseVersion: 0,
      operation: 'create',
      contentDiff: '# new note\n\nFresh draft.\n',
      rationale: 'extracted from session',
      confidence: 0.85,
      sourceRefs: ['conversation:cv_xxx'],
      sessionId: `s_${suffix}`,
    });
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.operation, 'create');
    assert.equal(proposal.proposingAgentId, agent1Id);
  });

  await runTest('create — non-agent rejected with owner_only style 403', async () => {
    await assert.rejects(
      proposals.create({
        acl: await ownerAcl(),
        pagePath: 'memory/p/x.md',
        baseVersion: 0,
        operation: 'create',
        contentDiff: '# x',
        confidence: 0.5,
        sourceRefs: ['cv:1'],
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'agent_only',
    );
  });

  await runTest('create — invalid confidence rejected', async () => {
    await assert.rejects(
      proposals.create({
        acl: await agentAcl(),
        pagePath: 'memory/p/x.md',
        baseVersion: 0,
        operation: 'create',
        contentDiff: '# x',
        confidence: 1.5,
        sourceRefs: ['cv:1'],
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'invalid_confidence',
    );
  });

  await runTest('create — invalid operation rejected', async () => {
    await assert.rejects(
      proposals.create({
        acl: await agentAcl(),
        pagePath: 'memory/p/x.md',
        baseVersion: 0,
        operation: 'delete' as never,
        contentDiff: '# x',
        confidence: 0.5,
        sourceRefs: ['cv:1'],
      }),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'invalid_operation',
    );
  });

  // ─── list ─────────────────────────────────────────────────
  await runTest('list — filters by sessionId', async () => {
    const targetSession = `s_filter_${suffix}`;
    await proposals.create({
      acl: await agentAcl(),
      pagePath: 'memory/p/filter1.md',
      baseVersion: 0,
      operation: 'create',
      contentDiff: '# x',
      confidence: 0.5,
      sourceRefs: ['cv:1'],
      sessionId: targetSession,
    });
    await proposals.create({
      acl: await agentAcl(),
      pagePath: 'memory/p/filter2.md',
      baseVersion: 0,
      operation: 'create',
      contentDiff: '# y',
      confidence: 0.5,
      sourceRefs: ['cv:1'],
      sessionId: 'other_session',
    });
    const list = await proposals.list({ acl: await ownerAcl(), sessionId: targetSession });
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionId, targetSession);
  });

  // ─── approve — apply create ───────────────────────────────
  await runTest('approve create — produces new IMMemoryPage', async () => {
    const proposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: `memory/p/applied_create_${suffix}.md`,
      baseVersion: 0,
      operation: 'create',
      contentDiff: '# applied create\n',
      confidence: 0.9,
      sourceRefs: ['cv:1'],
    });
    const applied = await proposals.approve(await ownerAcl(), proposal.id);
    assert.equal(applied.status, 'applied');
    const page = await prisma.iMMemoryPage.findFirst({
      where: { workspaceId: ws, path: `memory/p/applied_create_${suffix}.md`, deletedAt: null },
    });
    assert.ok(page);
    assert.equal(page!.version, 1);
    assert.match(page!.content, /applied create/);
  });

  // ─── approve — append on existing page ────────────────────
  await runTest('approve append — bumps page.version + writes IMMemoryPageVersion', async () => {
    const ownerAclVal = await ownerAcl();
    const page = await writer.createPage({
      acl: ownerAclVal,
      path: `memory/p/append_target_${suffix}.md`,
      content: '# target\n\nfirst para\n',
      sourceRefs: ['cv:1'],
    });
    const proposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: page.path,
      baseVersion: page.version,
      operation: 'append',
      contentDiff: '\nsecond para from agent\n',
      confidence: 0.7,
      sourceRefs: ['cv:1'],
    });
    const applied = await proposals.approve(ownerAclVal, proposal.id);
    assert.equal(applied.status, 'applied');
    const after = await prisma.iMMemoryPage.findFirst({
      where: { id: page.id },
    });
    assert.equal(after!.version, page.version + 1);
    assert.match(after!.content, /second para from agent/);
    const versions = await prisma.iMMemoryPageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { version: 'desc' },
    });
    assert.ok(versions.length >= 2);
    assert.equal(versions[0].sourceKind, 'proposal');
  });

  // ─── approve — baseVersion drift 409 ──────────────────────
  await runTest('approve — baseVersion drift returns 409 with currentVersion', async () => {
    const ownerAclVal = await ownerAcl();
    const page = await writer.createPage({
      acl: ownerAclVal,
      path: `memory/p/drift_${suffix}.md`,
      content: '# drift\n',
      sourceRefs: ['cv:1'],
    });
    const proposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: page.path,
      baseVersion: page.version,
      operation: 'append',
      contentDiff: '\nappend\n',
      confidence: 0.8,
      sourceRefs: ['cv:1'],
    });
    // Concurrent edit — bumps version
    await prisma.iMMemoryPage.update({
      where: { id: page.id },
      data: { version: { increment: 1 }, content: '# drift\n\nconcurrent edit\n' },
    });
    let captured: MemoryWriteError | null = null;
    try {
      await proposals.approve(ownerAclVal, proposal.id);
    } catch (err) {
      captured = err instanceof MemoryWriteError ? err : null;
    }
    assert.ok(captured, 'must throw MemoryWriteError on drift');
    assert.equal(captured!.code, 'baseVersion_drift');
    assert.equal(captured!.status, 409);
    assert.equal(captured!.meta?.currentVersion, page.version + 1);
    assert.equal(captured!.meta?.proposalBaseVersion, page.version);
  });

  // ─── approve — archive operation ──────────────────────────
  await runTest('approve archive — sets archivedAt on target page', async () => {
    const ownerAclVal = await ownerAcl();
    const page = await writer.createPage({
      acl: ownerAclVal,
      path: `memory/p/arch_target_${suffix}.md`,
      content: '# arch',
      sourceRefs: ['cv:1'],
    });
    const proposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: page.path,
      baseVersion: page.version,
      operation: 'archive',
      contentDiff: '',
      confidence: 0.95,
      sourceRefs: ['cv:1'],
    });
    await proposals.approve(ownerAclVal, proposal.id);
    const after = await prisma.iMMemoryPage.findUnique({ where: { id: page.id } });
    assert.ok(after!.archivedAt);
  });

  // ─── reject ───────────────────────────────────────────────
  await runTest('reject — sets status + reason', async () => {
    const proposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: `memory/p/reject_${suffix}.md`,
      baseVersion: 0,
      operation: 'create',
      contentDiff: '# x',
      confidence: 0.5,
      sourceRefs: ['cv:1'],
    });
    const updated = await proposals.reject(await ownerAcl(), proposal.id, 'not aligned with project goals');
    assert.equal(updated?.status, 'rejected');
    assert.equal(updated?.rejectionReason, 'not aligned with project goals');
  });

  await runTest('reject — agent caller rejected', async () => {
    const proposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: `memory/p/reject_403_${suffix}.md`,
      baseVersion: 0,
      operation: 'create',
      contentDiff: '# x',
      confidence: 0.5,
      sourceRefs: ['cv:1'],
    });
    await assert.rejects(
      proposals.reject(await agentAcl(), proposal.id, 'reason'),
      (err: unknown) => err instanceof MemoryWriteError && err.code === 'owner_only',
    );
  });

  // ─── bulk-approve mixed: success + drift skip ─────────────
  await runTest('bulk-approve — applies clean proposals, skips baseVersion drift', async () => {
    const ownerAclVal = await ownerAcl();
    // proposal 1: clean (create)
    const cleanProposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: `memory/p/bulk_clean_${suffix}.md`,
      baseVersion: 0,
      operation: 'create',
      contentDiff: '# clean',
      confidence: 0.9,
      sourceRefs: ['cv:1'],
      sessionId: `bulk_${suffix}`,
    });
    // proposal 2: target page exists, then concurrent bump → drift
    const target = await writer.createPage({
      acl: ownerAclVal,
      path: `memory/p/bulk_drift_${suffix}.md`,
      content: '# drift target',
      sourceRefs: ['cv:1'],
    });
    const driftProposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: target.path,
      baseVersion: target.version,
      operation: 'append',
      contentDiff: '\nappend\n',
      confidence: 0.7,
      sourceRefs: ['cv:1'],
      sessionId: `bulk_${suffix}`,
    });
    await prisma.iMMemoryPage.update({
      where: { id: target.id },
      data: { version: { increment: 1 } },
    });

    const result = await proposals.bulkApprove({
      acl: ownerAclVal,
      sessionId: `bulk_${suffix}`,
    });
    assert.equal(result.approved.length, 1);
    assert.equal(result.approved[0], cleanProposal.id);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].id, driftProposal.id);
    assert.equal(result.skipped[0].reason, 'baseVersion_drift');
    assert.equal(result.skipped[0].currentVersion, target.version + 1);
  });

  // ─── expire cron ──────────────────────────────────────────
  await runTest('expireOverdue — flips pending past expiresAt to expired', async () => {
    const proposal = await proposals.create({
      acl: await agentAcl(),
      pagePath: `memory/p/expire_${suffix}.md`,
      baseVersion: 0,
      operation: 'create',
      contentDiff: '# expired',
      confidence: 0.5,
      sourceRefs: ['cv:1'],
      ttlDays: 1,
    });
    // backdate expiresAt to past
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.iMMemoryProposal.update({ where: { id: proposal.id }, data: { expiresAt: past } });

    const result = await proposals.expireOverdue();
    assert.ok(result.expired >= 1);
    const updated = await prisma.iMMemoryProposal.findUnique({ where: { id: proposal.id } });
    assert.equal(updated?.status, 'expired');
  });

  console.log(`\n[memory-proposal] ${passed} passed, ${failed} failed`);
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
