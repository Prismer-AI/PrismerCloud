/**
 * Prismer IM — Wave 2-B1 — idempotencyKey UNIQUE race tests
 *
 * Verifies §4.1 idempotency invariants on a real MySQL connection:
 *
 *   I1. Two concurrent sendMessage calls with the SAME idempotencyKey
 *       resolve to the SAME message id. (app-level findByIdempotencyKey
 *       fast-path may miss the race — DB UNIQUE constraint catches it,
 *       message.service.send catches the unique violation and re-reads.)
 *
 *   I2. Two sequential sends with the SAME key produce ONE row.
 *
 *   I3. Direct prisma.iMMessage.create with the SAME (conversationId,
 *       idempotencyKey) fails P2002. (Documents the DB-level invariant.)
 *
 *   I4. NULL idempotencyKey is excluded from UNIQUE (MySQL semantics) —
 *       two rows with NULL key in the same conversation MAY co-exist.
 *
 * Run: DATABASE_URL=mysql://prismer:devpass@localhost:3307/prismer_cloud \
 *      npx tsx src/im/tests/idempotency-race.test.ts
 */

import prisma from '../db';
import Redis from 'ioredis';
import { SyncService } from '../services/sync.service';
import { MessageService } from '../services/message.service';

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

async function main() {
  console.log('\n=== Wave 2-B1: idempotency-race tests ===\n');

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  try {
    await redis.connect();
  } catch {
    /* fine */
  }
  const syncService = new SyncService();
  syncService.setRedis(redis);
  const messageService = new MessageService(redis as any, undefined as any, syncService);

  // ── Setup: throwaway conversation + 2 participants ────────────────────
  const userA = await prisma.iMUser.create({
    data: { username: `idem-user-a-${Date.now()}`, displayName: 'Idem A', role: 'human' },
  });
  const userB = await prisma.iMUser.create({
    data: { username: `idem-user-b-${Date.now()}`, displayName: 'Idem B', role: 'human' },
  });
  const conv = await prisma.iMConversation.create({ data: { type: 'direct', createdById: userA.id } });
  await prisma.iMParticipant.createMany({
    data: [
      { conversationId: conv.id, imUserId: userA.id, role: 'member' },
      { conversationId: conv.id, imUserId: userB.id, role: 'member' },
    ],
  });

  try {
    // ── I1: concurrent same-key send → one message ──────────────────────
    await test('I1 concurrent same-key sends → one message id', async () => {
      const idem = `i1-${Date.now()}`;
      // Race 8x to maximize the probability of overlap
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          messageService.send({
            conversationId: conv.id,
            senderId: userA.id,
            content: 'race body',
            metadata: { _idempotencyKey: idem },
          }),
        ),
      );
      const ids = new Set(results.map((r) => r.message.id));
      assert(ids.size === 1, `expected 1 unique id, got ${ids.size}: ${[...ids].join(',')}`);

      // And only one row in DB
      const rows = await prisma.iMMessage.findMany({
        where: { conversationId: conv.id, idempotencyKey: idem },
      });
      assert(rows.length === 1, `expected 1 DB row, got ${rows.length}`);
    });

    // ── I2: sequential same-key send → one row ──────────────────────────
    await test('I2 sequential same-key sends → one row', async () => {
      const idem = `i2-${Date.now()}`;
      const r1 = await messageService.send({
        conversationId: conv.id,
        senderId: userB.id,
        content: 'seq1',
        metadata: { _idempotencyKey: idem },
      });
      const r2 = await messageService.send({
        conversationId: conv.id,
        senderId: userB.id,
        content: 'seq2', // body intentionally different — idem wins
        metadata: { _idempotencyKey: idem },
      });
      assert(r1.message.id === r2.message.id, `seq IDs differ: ${r1.message.id} ${r2.message.id}`);
    });

    // ── I3: direct DB insert with same (cid, idemKey) fails P2002 ───────
    await test('I3 raw INSERT same (cid, idemKey) → P2002 unique violation', async () => {
      const idem = `i3-${Date.now()}`;
      const row1 = await prisma.iMMessage.create({
        data: {
          conversationId: conv.id,
          senderId: userA.id,
          type: 'text',
          content: 'i3-a',
          idempotencyKey: idem,
        },
      });
      let caught = false;
      try {
        await prisma.iMMessage.create({
          data: {
            conversationId: conv.id,
            senderId: userA.id,
            type: 'text',
            content: 'i3-b',
            idempotencyKey: idem,
          },
        });
      } catch (e) {
        caught = true;
        const code = (e as any).code;
        assert(code === 'P2002', `expected P2002, got ${code}`);
      }
      assert(caught, 'expected UNIQUE violation');
      await prisma.iMMessage.delete({ where: { id: row1.id } });
    });

    // ── I4: NULL idempotencyKey is not de-duped by UNIQUE ───────────────
    await test('I4 NULL idempotencyKey: multiple rows allowed (MySQL NULL semantics)', async () => {
      const r1 = await prisma.iMMessage.create({
        data: {
          conversationId: conv.id,
          senderId: userA.id,
          type: 'text',
          content: 'null-key-1',
          idempotencyKey: null,
        },
      });
      const r2 = await prisma.iMMessage.create({
        data: {
          conversationId: conv.id,
          senderId: userA.id,
          type: 'text',
          content: 'null-key-2',
          idempotencyKey: null,
        },
      });
      assert(r1.id !== r2.id, 'both NULL-key rows committed');
      await prisma.iMMessage.deleteMany({ where: { id: { in: [r1.id, r2.id] } } });
    });
  } finally {
    await prisma.iMSyncEvent.deleteMany({ where: { conversationId: conv.id } });
    await prisma.iMMessage.deleteMany({ where: { conversationId: conv.id } });
    await prisma.iMParticipant.deleteMany({ where: { conversationId: conv.id } });
    await prisma.iMConversationSeq.deleteMany({ where: { conversationId: conv.id } });
    await prisma.iMConversation.delete({ where: { id: conv.id } });
    await prisma.iMUser.delete({ where: { id: userA.id } });
    await prisma.iMUser.delete({ where: { id: userB.id } });
    await redis.quit().catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
