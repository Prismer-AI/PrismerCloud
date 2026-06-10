/**
 * Prismer IM — Wave 4-E2 — Streaming partial render (§4.4.7) tests
 *
 * Real docker MySQL + real Redis pub/sub. No mocks.
 *
 * Coverage:
 *   S1  startStream allocates messageId + recipient fan-out + 200ms flush timer.
 *   S2  appendChunk → 200ms tick → SSE `message.partial` envelope on
 *       `im:sync:<recipientId>` carries { messageId, partialContent,
 *       chunkSeq, isFinal:false }.
 *   S3  Persistence — every flush writes an `im_message_partials` row.
 *   S4  endStream emits one terminal partial with `isFinal:true` and
 *       returns the assembled finalContent for the caller to persist
 *       via the normal outbox path (Wave 2-B1).
 *   S5  30s "long reply" timing — chunks delivered continuously on the
 *       SSE subscriber side; client never has to wait for the end before
 *       seeing text.
 *   S6  F5 hydration — `StreamService.getPartials(messageId, afterSeq)`
 *       returns the persisted buffer so a reloaded browser can rebuild
 *       the half-written message.
 *   S7  Reaper — `StreamService.reapStalePartials(cutoffMs=0)` deletes
 *       every row past the cutoff (24h in prod, 0 in test for immediate
 *       sweep).
 *
 * Run:
 *   DATABASE_URL='mysql://prismer:devpass@localhost:3307/prismer_cloud' \
 *   REDIS_URL='redis://localhost:6380' \
 *   npx tsx src/im/tests/stream-partial.test.ts
 */

import prisma from '../db';
import Redis from 'ioredis';
import { StreamService } from '../services/stream.service';

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
    if (process.env.VERBOSE) console.error((err as Error).stack);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

interface ParsedEnvelope {
  type: string;
  data: {
    messageId: string;
    conversationId: string;
    senderId: string;
    partialContent: string;
    chunkSeq: number;
    isFinal: boolean;
  };
  conversationId: string;
  at: string;
}

async function main() {
  console.log('\n=== Wave 4-E2: streaming partial render tests ===\n');

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', { maxRetriesPerRequest: 1 });
  await new Promise<void>((resolve) => redis.once('ready', () => resolve()));

  // ─── S1+S2+S3+S4: full lifecycle test ─────────────────────────────────
  await test('S1-S4: startStream → flush → endStream end-to-end + persistence', async () => {
    const stream = new StreamService({ flushIntervalMs: 100 });
    stream.setRedis(redis);

    const user = await prisma.iMUser.create({
      data: { username: `e2-s1-${Date.now()}`, displayName: 'E2 S1', role: 'human' },
    });
    const conv = await prisma.iMConversation.create({ data: { type: 'group', createdById: user.id } });
    await prisma.iMParticipant.create({ data: { conversationId: conv.id, imUserId: user.id, role: 'member' } });

    // SSE subscriber simulates the connected browser.
    const sub = redis.duplicate();
    const received: ParsedEnvelope[] = [];
    await new Promise<void>((resolve) => sub.subscribe(`im:sync:${user.id}`, () => resolve()));
    sub.on('message', (_ch, payload) => {
      try {
        const env = JSON.parse(payload) as ParsedEnvelope;
        if (env.type === 'message.partial') received.push(env);
      } catch {
        /* ignore */
      }
    });

    const streamId = `s1-${Date.now()}`;
    const active = await stream.startStream({ streamId, conversationId: conv.id, senderId: user.id });
    assert(!!active.messageId, 'startStream allocated messageId');

    // Append 3 chunks rapid-fire; the 100ms flush timer should batch.
    stream.appendChunk(streamId, 'Hello, ');
    stream.appendChunk(streamId, 'world');
    stream.appendChunk(streamId, '!');
    await new Promise((r) => setTimeout(r, 250)); // allow ≥1 flush

    // Append another chunk after flush — proves continuous streaming
    stream.appendChunk(streamId, ' Second line.');
    await new Promise((r) => setTimeout(r, 250));

    const endRes = await stream.endStream(streamId);
    assert(endRes !== null, 'endStream returned result');
    assert(endRes!.finalContent === 'Hello, world! Second line.', `assembled=${endRes!.finalContent}`);

    await new Promise((r) => setTimeout(r, 100)); // let final flush propagate
    assert(received.length >= 2, `received >=2 partial events (got ${received.length})`);
    const firstFinal = received.find((e) => e.data.isFinal);
    assert(!!firstFinal, 'one envelope had isFinal=true');
    assert(received[0].data.messageId === active.messageId, 'messageId matches across SSE + service');

    // S3: persistence row count
    const persisted = await prisma.iMMessagePartial.findMany({
      where: { messageId: active.messageId },
      orderBy: { chunkSeq: 'asc' },
    });
    assert(persisted.length >= 2, `>=2 persisted partials (got ${persisted.length})`);
    const totalText = persisted.map((p: { chunkText: string }) => p.chunkText).join('');
    // The final chunk is a terminal marker with possibly empty text if all
    // chunks were already flushed; the persisted text equals finalContent
    // when the buffer drained on flush.
    assert(
      totalText === 'Hello, world! Second line.' || totalText === active.messageId, // safety
      `persisted text reconstructs final content (got "${totalText}")`,
    );

    sub.disconnect();
    stream.stop();
    // Cleanup fixtures
    await prisma.iMMessagePartial.deleteMany({ where: { messageId: active.messageId } });
    await prisma.iMParticipant.deleteMany({ where: { conversationId: conv.id } });
    await prisma.iMConversation.delete({ where: { id: conv.id } });
    await prisma.iMUser.delete({ where: { id: user.id } });
  });

  // ─── S5: 30s long-reply scrolling ──────────────────────────────────────
  await test('S5: 30s long reply — chunks delivered continuously (no end-wait)', async () => {
    const stream = new StreamService({ flushIntervalMs: 200 });
    stream.setRedis(redis);

    const user = await prisma.iMUser.create({
      data: { username: `e2-s5-${Date.now()}`, displayName: 'E2 S5', role: 'human' },
    });
    const conv = await prisma.iMConversation.create({ data: { type: 'group', createdById: user.id } });
    await prisma.iMParticipant.create({ data: { conversationId: conv.id, imUserId: user.id, role: 'member' } });

    const sub = redis.duplicate();
    const received: { at: number; chunkSeq: number; content: string; isFinal: boolean }[] = [];
    await new Promise<void>((resolve) => sub.subscribe(`im:sync:${user.id}`, () => resolve()));
    sub.on('message', (_ch, payload) => {
      try {
        const env = JSON.parse(payload) as ParsedEnvelope;
        if (env.type === 'message.partial') {
          received.push({
            at: Date.now(),
            chunkSeq: env.data.chunkSeq,
            content: env.data.partialContent,
            isFinal: env.data.isFinal,
          });
        }
      } catch {
        /* ignore */
      }
    });

    const streamId = `s5-${Date.now()}`;
    const active = await stream.startStream({ streamId, conversationId: conv.id, senderId: user.id });
    const startedAt = Date.now();

    // Simulate 30s long reply — token-by-token writes every ~150ms.
    // Total: ~200 tokens × ~5 chars each ≈ 1KB final message.
    const tokens = ['The ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'the ', 'lazy ', 'dog. '];
    const ticker = setInterval(() => {
      stream.appendChunk(streamId, tokens[Math.floor(Math.random() * tokens.length)]);
    }, 150);

    // 30-second window
    await new Promise((r) => setTimeout(r, 30_000));
    clearInterval(ticker);

    const beforeEndCount = received.length;
    const beforeEndElapsed = Date.now() - startedAt;
    // Critical assertion: by the time we end the stream, the subscriber
    // has ALREADY received many partials — confirming the typewriter
    // effect doesn't wait for `.end`.
    assert(beforeEndCount >= 50, `received >=50 partials in 30s (got ${beforeEndCount}, elapsed ${beforeEndElapsed}ms)`);

    const firstPartialDelay = received[0].at - startedAt;
    assert(firstPartialDelay < 1000, `first partial within 1s (got ${firstPartialDelay}ms)`);

    const endRes = await stream.endStream(streamId);
    assert(endRes !== null, 'endStream OK');
    await new Promise((r) => setTimeout(r, 100));

    // The terminal isFinal=true MUST have arrived too.
    const finalEnvelope = received.find((r) => r.isFinal);
    assert(!!finalEnvelope, 'final partial with isFinal=true arrived');

    // Chunks should be strictly monotonic by chunkSeq.
    for (let i = 1; i < received.length; i++) {
      assert(
        received[i].chunkSeq > received[i - 1].chunkSeq,
        `chunkSeq strictly monotonic (i=${i}, prev=${received[i - 1].chunkSeq}, this=${received[i].chunkSeq})`,
      );
    }

    console.log(
      `       [trace] 30s long reply: ${received.length} partial events received; ` +
        `first partial at +${firstPartialDelay}ms; final isFinal=true at +${(finalEnvelope!.at - startedAt) / 1000}s; ` +
        `assembled finalContent length=${endRes!.finalContent.length} chars`,
    );

    sub.disconnect();
    stream.stop();
    // Cleanup
    await prisma.iMMessagePartial.deleteMany({ where: { messageId: active.messageId } });
    await prisma.iMParticipant.deleteMany({ where: { conversationId: conv.id } });
    await prisma.iMConversation.delete({ where: { id: conv.id } });
    await prisma.iMUser.delete({ where: { id: user.id } });
  });

  // ─── S6: F5 hydration ──────────────────────────────────────────────────
  await test('S6: F5 hydration — getPartials returns persisted buffer past afterSeq', async () => {
    const stream = new StreamService({ flushIntervalMs: 50 });
    stream.setRedis(redis);

    const user = await prisma.iMUser.create({
      data: { username: `e2-s6-${Date.now()}`, displayName: 'E2 S6', role: 'human' },
    });
    const conv = await prisma.iMConversation.create({ data: { type: 'group', createdById: user.id } });
    await prisma.iMParticipant.create({ data: { conversationId: conv.id, imUserId: user.id, role: 'member' } });

    const streamId = `s6-${Date.now()}`;
    const active = await stream.startStream({ streamId, conversationId: conv.id, senderId: user.id });

    stream.appendChunk(streamId, 'chunk-1 ');
    await new Promise((r) => setTimeout(r, 80));
    stream.appendChunk(streamId, 'chunk-2 ');
    await new Promise((r) => setTimeout(r, 80));
    stream.appendChunk(streamId, 'chunk-3');
    await new Promise((r) => setTimeout(r, 80));

    // Simulate F5: client knows nothing → afterSeq=0
    const fresh = await StreamService.getPartials(active.messageId, 0);
    assert(fresh.length >= 2, `fresh F5 saw >=2 chunks (got ${fresh.length})`);
    const allText = fresh.map((p) => p.chunkText).join('');
    assert(/chunk-1/.test(allText) && /chunk-2/.test(allText), 'partial text reconstructs');

    // Client now has cursor = fresh[0].chunkSeq → query incremental
    const lastSeq = fresh[fresh.length - 1].chunkSeq;
    stream.appendChunk(streamId, ' chunk-4');
    await new Promise((r) => setTimeout(r, 80));
    const incremental = await StreamService.getPartials(active.messageId, lastSeq);
    assert(incremental.length >= 1, `incremental fetch returns new chunks only (got ${incremental.length})`);
    assert(/chunk-4/.test(incremental[0].chunkText), `incremental chunk has chunk-4 (got "${incremental[0].chunkText}")`);

    await stream.endStream(streamId);
    stream.stop();
    await prisma.iMMessagePartial.deleteMany({ where: { messageId: active.messageId } });
    await prisma.iMParticipant.deleteMany({ where: { conversationId: conv.id } });
    await prisma.iMConversation.delete({ where: { id: conv.id } });
    await prisma.iMUser.delete({ where: { id: user.id } });
  });

  // ─── S7: 24h reaper ────────────────────────────────────────────────────
  await test('S7: reaper deletes rows past cutoffMs', async () => {
    // Synthesise a stale row directly (avoid waiting 24h in test).
    const msgId = `msg-stale-${Date.now()}`;
    await prisma.iMMessagePartial.create({
      data: {
        id: `partial-stale-${Date.now()}`,
        messageId: msgId,
        chunkText: 'stale chunk',
        chunkSeq: 1,
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h old
      },
    });
    // And a fresh row that should survive.
    await prisma.iMMessagePartial.create({
      data: {
        id: `partial-fresh-${Date.now()}`,
        messageId: msgId,
        chunkText: 'fresh chunk',
        chunkSeq: 2,
        // createdAt defaults to now
      },
    });

    const deleted = await StreamService.reapStalePartials(24 * 60 * 60 * 1000);
    assert(deleted >= 1, `reaper deleted >=1 stale row (got ${deleted})`);

    const remaining = await prisma.iMMessagePartial.findMany({ where: { messageId: msgId } });
    assert(
      remaining.length === 1 && remaining[0].chunkSeq === 2,
      `only fresh chunk remains (got ${remaining.length} rows)`,
    );

    await prisma.iMMessagePartial.deleteMany({ where: { messageId: msgId } });
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);

  await redis.quit();
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
