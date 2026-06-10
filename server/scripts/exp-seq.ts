/**
 * Experiment: verify §4.1 LAST_INSERT_ID seq-allocation scheme actually
 * works through Prisma $executeRaw + $queryRaw under concurrency.
 */
import { PrismaClient } from '../prisma/generated/mysql';

const prisma = new PrismaClient();

async function nextSeq(conversationId: string): Promise<bigint> {
  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO im_conversation_seq_test (conversationId, seq) VALUES (${conversationId}, 1)
      ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)
    `;
    const rows = await tx.$queryRaw<[{ seq: bigint }]>`SELECT LAST_INSERT_ID() AS seq`;
    return rows[0].seq;
  });
}

async function nextSeqNoTx(conversationId: string): Promise<bigint> {
  // Variant: without explicit transaction (relies on single mysql connection per call).
  await prisma.$executeRaw`
    INSERT INTO im_conversation_seq_test (conversationId, seq) VALUES (${conversationId}, 1)
    ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)
  `;
  const rows = await prisma.$queryRaw<[{ seq: bigint }]>`SELECT LAST_INSERT_ID() AS seq`;
  return rows[0].seq;
}

async function setup() {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS im_conversation_seq_test`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE im_conversation_seq_test (
      conversationId VARCHAR(30) PRIMARY KEY,
      seq BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB
  `);
}

async function single() {
  console.log('--- single-thread (tx variant) ---');
  for (let i = 0; i < 5; i++) {
    const s = await nextSeq('conv-A');
    console.log(`alloc ${i + 1}:`, String(s));
  }
}

async function concurrent(n: number, conv: string, fn: (c: string) => Promise<bigint>, label: string) {
  console.log(`--- ${n} concurrent (${label}) on ${conv} ---`);
  const t0 = Date.now();
  let errored = 0;
  const results: bigint[] = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      try {
        results.push(await fn(conv));
      } catch (e) {
        errored++;
        if (errored <= 3) console.error('   err:', (e as Error).message.slice(0, 200));
      }
    }),
  );
  const dt = Date.now() - t0;
  const nums = results.map(Number).sort((a, b) => a - b);
  const set = new Set(nums);
  const dupes = nums.length - set.size;
  let gaps = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) gaps++;
  console.log(`   done in ${dt}ms; count=${results.length} errored=${errored} min=${nums[0]} max=${nums[nums.length - 1]} dupes=${dupes} gaps=${gaps}`);
}

async function main() {
  await setup();
  await single();
  await concurrent(50, 'conv-B', nextSeq, 'tx');
  await concurrent(200, 'conv-C', nextSeq, 'tx');
  await concurrent(200, 'conv-D', nextSeqNoTx, 'no-tx');
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
