/**
 * Prismer IM — Wave 2-B1 — SyncPublisher worker tests
 *
 * Verifies:
 *   P1. A pending IMSyncEvent row (publishedAt=NULL) is published to its
 *       per-recipient Redis channel and `publishedAt` is stamped.
 *
 *   P2. A failed publish (e.g. Redis disconnect) bumps `publishRetries`
 *       without stamping `publishedAt`, and the next tick retries the
 *       same row.
 *
 *   P3. Restart resilience — events accumulated while the publisher is
 *       not running are drained when it starts again. (Persistence
 *       guarantee: publishedAt is the only thing we look at — id ordering
 *       handles "what's pending".)
 *
 * Run: DATABASE_URL=mysql://prismer:devpass@localhost:3307/prismer_cloud \
 *      npx tsx src/im/tests/sync-publisher.test.ts
 */

import prisma from '../db';
import Redis from 'ioredis';
import { SyncService } from '../services/sync.service';
import { SyncPublisherService } from '../services/sync-publisher.service';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function withCleanup<T>(setup: () => Promise<T>, run: (ctx: T) => Promise<void>) {
  const ctx = await setup();
  try {
    await run(ctx);
  } finally {
    // Best-effort
  }
}

async function main() {
  console.log('\n=== Wave 2-B1: sync-publisher tests ===\n');

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: 1,
  });
  // Wait for connect (lazyConnect=false default)
  await new Promise<void>((resolve) => redis.once('ready', () => resolve()));

  // ── P1: publishedAt stamp + delivered to Redis ────────────────────────
  await test('P1 pending row → publishedAt set, Redis subscriber gets payload', async () => {
    const syncService = new SyncService();
    syncService.setRedis(redis);
    const publisher = new SyncPublisherService(syncService, { intervalMs: 20 });

    const user = await prisma.iMUser.create({
      data: { username: `p1-user-${Date.now()}`, displayName: 'P1 User', role: 'human' },
    });
    const conv = await prisma.iMConversation.create({ data: { type: 'group', createdById: user.id } });
    await prisma.iMParticipant.create({
      data: { conversationId: conv.id, imUserId: user.id, role: 'member' },
    });

    // Subscribe BEFORE publishing
    const sub = redis.duplicate();
    const received: string[] = [];
    await new Promise<void>((resolve) => sub.subscribe(`im:sync:${user.id}`, () => resolve()));
    sub.on('message', (_ch, payload) => received.push(payload));

    try {
      // Write event WITH a tx so boundarySeq is allocated
      await prisma.$transaction(async (tx: any) => {
        await syncService.writeEvent('test.publisher.p1', { hello: 'world' }, conv.id, user.id, tx);
      });

      // Verify row was persisted with publishedAt=NULL
      const row = await prisma.iMSyncEvent.findFirst({
        where: { conversationId: conv.id, type: 'test.publisher.p1' },
      });
      assert(!!row, 'sync event row created');
      assert(row!.publishedAt === null, 'publishedAt is NULL pre-publisher');
      assert(row!.boundarySeq != null, 'boundarySeq populated');

      // Run one tick
      const tickResult = await publisher.tick();
      assert(tickResult.published >= 1, `published count = ${tickResult.published}`);

      // Wait briefly for pub/sub delivery
      await new Promise((r) => setTimeout(r, 100));

      // publishedAt should now be set
      const rowAfter = await prisma.iMSyncEvent.findUnique({ where: { id: row!.id } });
      assert(rowAfter!.publishedAt !== null, 'publishedAt stamped');

      // Subscriber got the payload with boundarySeq
      assert(received.length >= 1, `subscriber received ${received.length} messages`);
      const evt = JSON.parse(received[received.length - 1]);
      assert(evt.type === 'test.publisher.p1', `event type=${evt.type}`);
      assert(typeof evt.boundarySeq === 'number', `boundarySeq numeric, got ${typeof evt.boundarySeq}`);
      assert(evt.seq === row!.id, `seq=id legacy field present`);
    } finally {
      publisher.stop();
      await sub.unsubscribe();
      await sub.quit();
      await prisma.iMSyncEvent.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMConversationSeq.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMParticipant.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMConversation.delete({ where: { id: conv.id } });
      await prisma.iMUser.delete({ where: { id: user.id } });
    }
  });

  // ── P2: publish failure → publishRetries++, publishedAt stays NULL ────
  await test('P2 publish failure → publishRetries++, no publishedAt', async () => {
    // Stub: a SyncService that always throws on publishPending
    const syncService = new SyncService();
    syncService.setRedis(redis);
    // Override publishPending to fail
    (syncService as any).publishPending = async () => {
      throw new Error('simulated redis failure');
    };
    const publisher = new SyncPublisherService(syncService, { intervalMs: 20 });

    const user = await prisma.iMUser.create({
      data: { username: `p2-user-${Date.now()}`, displayName: 'P2 User', role: 'human' },
    });
    const conv = await prisma.iMConversation.create({ data: { type: 'group', createdById: user.id } });
    await prisma.iMParticipant.create({
      data: { conversationId: conv.id, imUserId: user.id, role: 'member' },
    });

    try {
      await prisma.$transaction(async (tx: any) => {
        await syncService.writeEvent('test.publisher.p2', { x: 1 }, conv.id, user.id, tx);
      });

      const t1 = await publisher.tick();
      assert(t1.failed >= 1, `t1 failed=${t1.failed}`);

      const row1 = await prisma.iMSyncEvent.findFirst({
        where: { conversationId: conv.id, type: 'test.publisher.p2' },
      });
      assert(row1!.publishedAt === null, 'publishedAt still NULL after fail');
      assert(row1!.publishRetries === 1, `publishRetries=${row1!.publishRetries}`);

      // Second tick — retries the same row
      const t2 = await publisher.tick();
      assert(t2.failed >= 1, `t2 failed=${t2.failed}`);
      const row2 = await prisma.iMSyncEvent.findUnique({ where: { id: row1!.id } });
      assert(row2!.publishRetries === 2, `after retry publishRetries=${row2!.publishRetries}`);
    } finally {
      publisher.stop();
      await prisma.iMSyncEvent.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMConversationSeq.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMParticipant.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMConversation.delete({ where: { id: conv.id } });
      await prisma.iMUser.delete({ where: { id: user.id } });
    }
  });

  // ── P3: backlog drained after restart ─────────────────────────────────
  await test('P3 publisher restart drains accumulated backlog', async () => {
    const syncService = new SyncService();
    syncService.setRedis(redis);
    const publisher = new SyncPublisherService(syncService, { intervalMs: 20 });

    const user = await prisma.iMUser.create({
      data: { username: `p3-user-${Date.now()}`, displayName: 'P3 User', role: 'human' },
    });
    const conv = await prisma.iMConversation.create({ data: { type: 'group', createdById: user.id } });
    await prisma.iMParticipant.create({
      data: { conversationId: conv.id, imUserId: user.id, role: 'member' },
    });

    try {
      // Accumulate 5 events WITHOUT the publisher running (simulating restart)
      for (let i = 0; i < 5; i++) {
        await prisma.$transaction(async (tx: any) => {
          await syncService.writeEvent('test.publisher.p3', { i }, conv.id, user.id, tx);
        });
      }

      const pendingBefore = await prisma.iMSyncEvent.count({
        where: { conversationId: conv.id, publishedAt: null },
      });
      assert(pendingBefore === 5, `pendingBefore=${pendingBefore}`);

      // Now run a single tick — should drain all 5
      const tickResult = await publisher.tick();
      assert(tickResult.published === 5, `tick.published=${tickResult.published} expected 5`);

      const pendingAfter = await prisma.iMSyncEvent.count({
        where: { conversationId: conv.id, publishedAt: null },
      });
      assert(pendingAfter === 0, `pendingAfter=${pendingAfter}`);
    } finally {
      publisher.stop();
      await prisma.iMSyncEvent.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMConversationSeq.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMParticipant.deleteMany({ where: { conversationId: conv.id } });
      await prisma.iMConversation.delete({ where: { id: conv.id } });
      await prisma.iMUser.delete({ where: { id: user.id } });
    }
  });

  await redis.quit();
  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
