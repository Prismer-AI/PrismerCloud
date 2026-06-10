/**
 * Wave 6 G5 — searchFiles ACL post-Option-B real-DB integration test (no mocks)
 *
 * Verifies the new behaviour after the legacy `ownerId = callerImUserId`
 * filter was removed from `memory-search.service.ts::fetchFileCandidates`:
 *
 *   1. Workspace-shared rows (ownerId = __shared__ sentinel) surface to
 *      EVERY workspace member's search, regardless of who wrote them.
 *   2. Agent-private rows remain isolated — caller A never sees caller B's
 *      private rows even when matching the same query string.
 *   3. Both FULLTEXT (MySQL) and LIKE-OR fallback paths honour the same ACL
 *      gate (scope OR-clause is the canonical authoritative gate).
 *
 * Real docker MySQL @ localhost:3307/prismer_cloud.
 */

import { PrismaClient } from '../prisma/generated/mysql/index.js';
import { MemoryService, WORKSPACE_SHARED_SENTINEL } from '../src/im/services/memory.service';
import { MemorySearchService } from '../src/im/services/memory-search.service';
import type { MemoryAclContext } from '../src/im/services/memory-acl';

process.env.DATABASE_URL = 'mysql://prismer:devpass@localhost:3307/prismer_cloud';

const prismaCli = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

interface AssertContext {
  name: string;
  passed: boolean;
  error?: string;
}
const results: AssertContext[] = [];
function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, passed: true });
      console.log(`  ✓ ${name}`);
    })
    .catch((err: Error) => {
      results.push({ name, passed: false, error: err.message });
      console.log(`  ✗ ${name}\n    ${err.message}`);
    });
}

async function main() {
  const tag = `w6g5_${Math.random().toString(36).slice(2, 8)}`;
  const wsId = `ws_${tag}`;
  const aliceId = `agent_alice_${tag}`;
  const bobId = `agent_bob_${tag}`;
  const carolId = `agent_carol_${tag}`;
  const ownerId = `user_owner_${tag}`;

  console.log(`\nWave 6 G5 — real-DB ACL test`);
  console.log(`Prefix: ${tag}`);
  console.log(`DB: ${process.env.DATABASE_URL}\n`);

  await prismaCli.iMUser.createMany({
    data: [
      { id: ownerId, role: 'human', displayName: `owner-${tag}`, username: `owner_${tag}` } as any,
      { id: aliceId, role: 'agent', displayName: `alice-${tag}`, username: `alice_${tag}` } as any,
      { id: bobId, role: 'agent', displayName: `bob-${tag}`, username: `bob_${tag}` } as any,
      { id: carolId, role: 'agent', displayName: `carol-${tag}`, username: `carol_${tag}` } as any,
    ],
  });

  await prismaCli.iMWorkspace.create({
    data: {
      id: wsId,
      name: `ws-${tag}`,
      ownerImUserId: ownerId,
      slug: `ws-${tag}`,
    } as any,
  });

  const memSvc = new MemoryService();
  const searchSvc = new MemorySearchService();

  // ── Seed: 1 shared row + 2 agent-private rows (alice + bob) ──
  // unique token in content/desc/path so we can target via search
  const TOKEN = `wave6g5tag${tag}`;

  const sharedRow = await memSvc.writeMemoryFile(
    wsId,
    aliceId, // writer = alice
    'agent' as any,
    `shared/${TOKEN}/notes.md`,
    `shared content ${TOKEN} for whole workspace`,
    'workspace-shared',
    'reference',
    `shared ${TOKEN}`,
  );

  const alicePrivate = await memSvc.writeMemoryFile(
    wsId,
    aliceId,
    'agent' as any,
    `private/alice-${TOKEN}.md`,
    `alice private ${TOKEN} secrets`,
    'agent-private',
    'reference',
    `alice ${TOKEN}`,
    aliceId,
  );

  const bobPrivate = await memSvc.writeMemoryFile(
    wsId,
    bobId,
    'agent' as any,
    `private/bob-${TOKEN}.md`,
    `bob private ${TOKEN} secrets`,
    'agent-private',
    'reference',
    `bob ${TOKEN}`,
    bobId,
  );

  // Sanity: shared row uses sentinel
  await check('shared row ownerId=__shared__ + scope=workspace-shared', async () => {
    const fresh = await prismaCli.iMMemoryFile.findUnique({ where: { id: sharedRow.id } });
    if (!fresh) throw new Error('vanished');
    if (fresh.ownerId !== WORKSPACE_SHARED_SENTINEL) throw new Error(`ownerId=${fresh.ownerId}`);
    if ((fresh as any).scope !== 'workspace-shared') throw new Error(`scope=${(fresh as any).scope}`);
  });

  // ── Issue A acceptance: shared row visible to alice/bob/carol ──
  const buildAcl = (callerId: string): MemoryAclContext =>
    ({
      workspaceId: wsId,
      callerImUserId: callerId,
      callerRole: 'agent',
      allowedVisibilities: ['workspace', `agent:${callerId}`],
      allowedVisibilityPrefixes: ['agent:'],
      canRead: () => true,
      canWrite: () => true,
    }) as any;

  console.log('\n[group 1] workspace-shared visibility for ALL workspace members');
  for (const [name, callerId] of [
    ['alice (writer)', aliceId],
    ['bob (different agent)', bobId],
    ['carol (third agent who has not written anything)', carolId],
  ] as const) {
    await check(`${name} sees workspace-shared row via search`, async () => {
      const res = await searchSvc.search({ acl: buildAcl(callerId), query: TOKEN, kind: 'files' });
      const ids = res.data.files.map((f) => f.fileId);
      if (!ids.includes(sharedRow.id)) {
        throw new Error(`expected shared row ${sharedRow.id} in results, got ${JSON.stringify(ids)}`);
      }
    });
  }

  // ── Issue A acceptance: agent-private isolation across callers ──
  console.log('\n[group 2] agent-private cross-agent isolation');
  await check('alice sees own private row', async () => {
    const res = await searchSvc.search({ acl: buildAcl(aliceId), query: TOKEN, kind: 'files' });
    const ids = res.data.files.map((f) => f.fileId);
    if (!ids.includes(alicePrivate.id)) throw new Error(`alice should see own private ${alicePrivate.id}`);
  });
  await check('alice does NOT see bob private row', async () => {
    const res = await searchSvc.search({ acl: buildAcl(aliceId), query: TOKEN, kind: 'files' });
    const ids = res.data.files.map((f) => f.fileId);
    if (ids.includes(bobPrivate.id)) throw new Error(`alice leaked bob private ${bobPrivate.id}`);
  });
  await check('bob sees own private row', async () => {
    const res = await searchSvc.search({ acl: buildAcl(bobId), query: TOKEN, kind: 'files' });
    const ids = res.data.files.map((f) => f.fileId);
    if (!ids.includes(bobPrivate.id)) throw new Error(`bob should see own private ${bobPrivate.id}`);
  });
  await check('bob does NOT see alice private row', async () => {
    const res = await searchSvc.search({ acl: buildAcl(bobId), query: TOKEN, kind: 'files' });
    const ids = res.data.files.map((f) => f.fileId);
    if (ids.includes(alicePrivate.id)) throw new Error(`bob leaked alice private ${alicePrivate.id}`);
  });
  await check('carol (no writes) sees NEITHER private row', async () => {
    const res = await searchSvc.search({ acl: buildAcl(carolId), query: TOKEN, kind: 'files' });
    const ids = res.data.files.map((f) => f.fileId);
    if (ids.includes(alicePrivate.id) || ids.includes(bobPrivate.id)) {
      throw new Error(`carol leaked agent-private rows: ${JSON.stringify(ids)}`);
    }
  });

  // ── Issue A acceptance: workspace-shared visible alongside own private ──
  console.log('\n[group 3] combined visibility');
  await check('alice search returns BOTH shared + own private (not bob private)', async () => {
    const res = await searchSvc.search({ acl: buildAcl(aliceId), query: TOKEN, kind: 'files' });
    const ids = res.data.files.map((f) => f.fileId);
    const sawShared = ids.includes(sharedRow.id);
    const sawOwnPrivate = ids.includes(alicePrivate.id);
    const sawBobPrivate = ids.includes(bobPrivate.id);
    if (!sawShared || !sawOwnPrivate || sawBobPrivate) {
      throw new Error(`expected [shared=T,alicePriv=T,bobPriv=F], got [${sawShared},${sawOwnPrivate},${sawBobPrivate}]`);
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────
  console.log('\n[cleanup]');
  await prismaCli.iMMemoryFile.deleteMany({ where: { workspaceId: wsId } });
  await prismaCli.iMWorkspace.delete({ where: { id: wsId } });
  await prismaCli.iMUser.deleteMany({ where: { id: { in: [aliceId, bobId, carolId, ownerId] } } });
  console.log('  ✓ deleted seed rows');

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\nResults: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log('\nFailures:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
