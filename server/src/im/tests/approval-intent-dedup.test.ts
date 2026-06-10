/**
 * v2.0 §4.4.8.3 — Approval Intent Dedup (Wave 3.5 W2)
 *
 * Real-DB integration tests for ApprovalService intentHash compute + dedup.
 * NO MOCKS — runs against docker MySQL at localhost:3307.
 *
 * Setup:
 *   docker compose -f docker-compose.dev.yml up -d  # mysql + redis already running
 *   migration 411 must be applied (column im_approvals.intentHash + intent_idx)
 *
 * Run:
 *   DATABASE_URL="mysql://prismer:devpass@localhost:3307/prismer_cloud" \
 *     npx tsx src/im/tests/approval-intent-dedup.test.ts
 *
 * What this proves:
 *   1. intentHash is sha256(workspace|conv|category|taskId|hourBucket) — deterministic
 *   2. Same intent within 1h → second create returns existing approval id (dedup hit)
 *   3. Different hourBucket → new row (dedup miss)
 *   4. Different category → new row (dedup miss)
 *   5. metadata.taskId=null + no input.taskId → 'none' placeholder, dedup hit on
 *      identical "no task" approvals
 *   6. Legacy rows with intentHash=NULL stay queryable (back-compat)
 */

import 'dotenv/config';
import prisma from '@/lib/prisma';
import { RoomManager } from '@/im/ws/rooms';
import {
  ApprovalService,
  computeIntentHash,
  normalizeTaskId,
  hourBucket,
} from '@/im/services/approval.service';

// ─── Test infrastructure ────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: unknown) {
    failed++;
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

// ─── Stub deps (RoomManager works w/o Redis; TaskService methods only fire
//    on decideApproval, which we don't exercise here) ────────
const rooms = new RoomManager(); // no redis arg → in-memory only
const taskServiceStub: any = {
  fanOutApprovalBellSync: async () => {},
  dispatchApprovalDecisionToAgent: async () => {},
  applyApprovalDecisionAndRedispatch: async () => {},
};
const service = new ApprovalService({ rooms, taskService: taskServiceStub });

// ─── Fixtures: pick a real workspace + owner ────────────────
const TS = Date.now().toString().slice(-8);
const OWNER_ID = 'cmp1uhqwz0000xzwt6usm7m2e'; // tomwinshare
let WORKSPACE_ID = '';
let CONV_ID = '';

const TITLE_PREFIX = `dedup-test-${TS}`;

async function bootstrap() {
  // Find an existing workspace owned by tomwinshare to avoid creating fixture noise
  const ws = await prisma.iMWorkspace.findFirst({
    where: { ownerImUserId: OWNER_ID, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  if (!ws) throw new Error('No tomwinshare workspace — please create one first');
  WORKSPACE_ID = ws.id;

  // Find or create a conversation in this workspace where the owner is a participant
  let conv = await prisma.iMConversation.findFirst({
    where: {
      workspaceId: WORKSPACE_ID,
      participants: { some: { imUserId: OWNER_ID } },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!conv) {
    conv = await prisma.iMConversation.create({
      data: {
        id: `conv-dedup-${TS}`,
        workspaceId: WORKSPACE_ID,
        type: 'group',
        name: `dedup-test-${TS}`,
        createdById: OWNER_ID,
        participants: {
          create: [{ imUserId: OWNER_ID, role: 'owner' }],
        },
      } as any,
    });
  }
  CONV_ID = conv.id;

  console.log(`\n  ℹ workspace=${WORKSPACE_ID} conv=${CONV_ID} owner=${OWNER_ID}`);
}

async function cleanup() {
  try {
    const result = await prisma.iMApproval.deleteMany({
      where: { title: { startsWith: TITLE_PREFIX }, workspaceId: WORKSPACE_ID },
    });
    console.log(`\n  🧹 Cleaned ${result.count} test approval rows`);
  } catch (err) {
    console.error('cleanup failed', err);
  }
}

// ─── Tests ──────────────────────────────────────────────────

async function runTests() {
  console.log('\n📦 Approval Intent Dedup (W2 / §4.4.8.3) — real-DB tests\n');
  await bootstrap();

  // ── pure-function tests (no DB) ────────────────────────────
  await test('computeIntentHash is deterministic for identical inputs', () => {
    const at = new Date('2026-05-21T13:42:11.123Z');
    const h1 = computeIntentHash({
      workspaceId: 'ws-A',
      conversationId: 'conv-A',
      category: 'release',
      taskId: 'task-A',
      createdAt: at,
    });
    const h2 = computeIntentHash({
      workspaceId: 'ws-A',
      conversationId: 'conv-A',
      category: 'release',
      taskId: 'task-A',
      createdAt: at,
    });
    assert(h1 === h2, `expected stable hash, got ${h1} vs ${h2}`);
    assert(h1.length === 64, `expected 64-char hex, got len=${h1.length}`);
  });

  await test('computeIntentHash differs by 1h bucket', () => {
    const a = new Date('2026-05-21T13:00:00.000Z');
    const b = new Date('2026-05-21T14:00:00.000Z');
    const h1 = computeIntentHash({
      workspaceId: 'ws',
      conversationId: 'c',
      category: 'cat',
      taskId: 't',
      createdAt: a,
    });
    const h2 = computeIntentHash({
      workspaceId: 'ws',
      conversationId: 'c',
      category: 'cat',
      taskId: 't',
      createdAt: b,
    });
    assert(h1 !== h2, 'expected different hash for different hourBuckets');
  });

  await test('normalizeTaskId handles null/undefined/empty → "none"', () => {
    assert(normalizeTaskId(undefined) === 'none', 'undefined → none');
    assert(normalizeTaskId(null) === 'none', 'null → none');
    assert(normalizeTaskId('') === 'none', 'empty → none');
    assert(normalizeTaskId('  ') === 'none', 'whitespace → none');
    assert(normalizeTaskId('task-x') === 'task-x', 'plain → passthrough');
    assert(normalizeTaskId(42 as any) === 'none', 'non-string → none');
  });

  await test('hourBucket truncates ISO to "YYYY-MM-DDTHH"', () => {
    const out = hourBucket(new Date('2026-05-21T13:42:11.123Z'));
    assert(out === '2026-05-21T13', `expected 2026-05-21T13, got ${out}`);
  });

  // ── DB integration ────────────────────────────────────────
  let firstId = '';

  await test('1st createApproval writes intentHash + new row', async () => {
    const info = await service.createApproval(OWNER_ID, {
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
      category: 'release',
      title: `${TITLE_PREFIX}-A1`,
      context: 'first',
      metadata: { taskId: 'task-X' },
    });
    assert(!!info.id, 'expected id');
    assert(info.intentHash !== null, 'intentHash must be populated');
    assert(/^[0-9a-f]{64}$/.test(info.intentHash!), `intentHash must be 64-hex, got ${info.intentHash}`);
    firstId = info.id;

    const raw = await prisma.iMApproval.findUnique({ where: { id: info.id } });
    assert(raw!.intentHash === info.intentHash, 'DTO and DB row must agree on intentHash');
  });

  await test('2nd createApproval (same workspace+conv+cat+task, same hour) → dedup hit, SAME id', async () => {
    const info = await service.createApproval(OWNER_ID, {
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
      category: 'release',
      title: `${TITLE_PREFIX}-A2`, // different title, should still dedup
      context: 'second',
      metadata: { taskId: 'task-X' },
    });
    assert(info.id === firstId, `expected dedup to return ${firstId}, got ${info.id}`);
    assert(info.title.endsWith('-A1'), `expected original title (first row), got ${info.title}`);

    // verify DB only has one row for this intentHash
    const rows = await prisma.iMApproval.findMany({
      where: { workspaceId: WORKSPACE_ID, conversationId: CONV_ID, intentHash: info.intentHash, status: 'pending' },
    });
    assert(rows.length === 1, `expected exactly 1 row for intentHash, got ${rows.length}`);
  });

  await test('different category → new row (dedup miss)', async () => {
    const info = await service.createApproval(OWNER_ID, {
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
      category: 'spend', // different category
      title: `${TITLE_PREFIX}-B`,
      metadata: { taskId: 'task-X' },
    });
    assert(info.id !== firstId, 'expected new id (different category)');
    assert(info.intentHash !== null, 'intentHash must be populated');

    const firstRow = await prisma.iMApproval.findUnique({ where: { id: firstId } });
    assert(info.intentHash !== firstRow!.intentHash, 'different category must yield different intentHash');
  });

  await test('different hour bucket → new row (dedup miss across windows)', async () => {
    // Simulate "hour ago" by patching an existing row's hourBucket via raw intentHash
    // Strategy: insert a new approval, then manually rewrite its intentHash to look
    // like it was 2h ago, and confirm a fresh create now mints a new row.
    const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const stale = computeIntentHash({
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
      category: 'retro',
      taskId: 'task-Y',
      createdAt: earlier,
    });
    const staleRow = await prisma.iMApproval.create({
      data: {
        workspaceId: WORKSPACE_ID,
        conversationId: CONV_ID,
        requestedById: OWNER_ID,
        category: 'retro',
        intentHash: stale,
        title: `${TITLE_PREFIX}-C-stale`,
        context: 'stale',
        options: '[]',
        metadata: JSON.stringify({ taskId: 'task-Y' }),
        status: 'pending',
        createdAt: earlier,
      } as any,
    });
    assert(staleRow.intentHash === stale, 'stale row intentHash should match');

    // Now create a fresh approval — current hourBucket differs, so dedup must miss
    const fresh = await service.createApproval(OWNER_ID, {
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
      category: 'retro',
      title: `${TITLE_PREFIX}-C-fresh`,
      metadata: { taskId: 'task-Y' },
    });
    assert(fresh.id !== staleRow.id, 'expected new id for new hour bucket');
    assert(fresh.intentHash !== stale, 'expected fresh intentHash');
  });

  await test('metadata without taskId → "none" placeholder, dedup still works', async () => {
    const first = await service.createApproval(OWNER_ID, {
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
      category: 'untaskeddedup',
      title: `${TITLE_PREFIX}-D1`,
      // no taskId, no metadata.taskId
    });
    const second = await service.createApproval(OWNER_ID, {
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
      category: 'untaskeddedup',
      title: `${TITLE_PREFIX}-D2`,
      // no taskId, no metadata.taskId
    });
    assert(second.id === first.id, `expected dedup hit on "no task" bucket, got ${first.id} vs ${second.id}`);
  });

  await test('legacy row with intentHash=NULL still queryable (back-compat)', async () => {
    const legacy = await prisma.iMApproval.create({
      data: {
        workspaceId: WORKSPACE_ID,
        conversationId: CONV_ID,
        requestedById: OWNER_ID,
        category: 'legacy',
        intentHash: null, // pre-411 row
        title: `${TITLE_PREFIX}-E-legacy`,
        options: '[]',
        metadata: '{}',
      } as any,
    });
    const fetched = await prisma.iMApproval.findUnique({ where: { id: legacy.id } });
    assert(fetched !== null, 'legacy row must be queryable');
    assert(fetched!.intentHash === null, 'legacy intentHash must still be null (no backfill)');

    // findPendingByIntentHash with hash X must NOT return legacy row (NULL ≠ X)
    const lookup = await service.findPendingByIntentHash({
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
      intentHash: 'somecomputedhash',
    });
    assert(
      lookup === null || lookup.id !== legacy.id,
      'legacy NULL intentHash must not match a real hash lookup',
    );
  });

  await test('listApprovals returns intentHash field on DTO', async () => {
    const list = await service.listApprovals(OWNER_ID, {
      workspaceId: WORKSPACE_ID,
      conversationId: CONV_ID,
    });
    const dedupRow = list.find((a) => a.id === firstId);
    assert(!!dedupRow, 'first row must appear in list');
    assert(dedupRow!.intentHash !== null && dedupRow!.intentHash.length === 64, 'DTO must surface intentHash');
  });

  await cleanup();

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    - ${f}`);
    process.exit(1);
  }
}

runTests()
  .catch(async (err) => {
    console.error('\n💥 Test runner crashed:', err);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
